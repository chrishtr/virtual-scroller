const DEBUG = true;

function DLOG(...messages) {
  if (!DEBUG) {
    return;
  }
  console.log(...messages);
}

function composedTreeParent(node) {
  return node.assignedSlot || node.host || node.parentNode;
}

function nearestScrollingAncestor(node) {
  for (node = composedTreeParent(node); node !== null;
       node = composedTreeParent(node)) {
    if (node.nodeType === Node.ELEMENT_NODE &&
        node.scrollHeight > node.clientHeight) {
      return node;
    }
  }
  return null;
}

const DEFAULT_HEIGHT_ESTIMATE = 100;
const TEMPLATE = `
<style>
:host {
  /* Browsers will automatically change the scroll position after we modify the
   * DOM, unless we turn it off with this property. We want to do the adjustments
   * ourselves in [_update](), instead. */
  overflow-anchor: none;
}

#emptySpaceSentinelContainer {
  contain: size layout style;
  pointer-events: none;
  visibility: hidden;
  overflow: visible;
  position: relative;
  height: 0px;
}

#emptySpaceSentinelContainer > div {
  contain: strict;
  position: absolute;
  width: 100%;
}

::slotted(*) {
  display: block !important;
  position: relative !important;
  contain: layout style
}

#outerContainer { contain: layout style }
</style>
<div id="outerContainer">
  <div id="innerContainer">
    <div id="emptySpaceSentinelContainer"></div>
    <slot></slot>
  </div>
</div>
`;

class Offset {
  constructor(offset, element) {
    this.offset = offset;
    this.element = element;
  }
}

// Represents a range of pixels, from |low| to |high|. |lowElement| if present
// is an element having lowest edge equal to |low| and |highElement| if present
// is an element having highest edge eqla to |high|.
class Range {
  constructor(low, high, lowElement, highElement) {
    this.low = low;
    this.high = high;
    this.lowElement = lowElement;
    this.highElement = highElement;
  }

  // this :  -----------
  // other:    ------
  // result: --      ---
  minus(other) {
    let lowUncovered, highUncovered;
    if (this.low < other.low) {
      lowUncovered = new Range(this.low, other.low, this.lowElement,
                               other.lowElement ? other.lowElement.previousElementSibling : null);
    }
    if (this.high > other.high) {
      highUncovered = new Range(other.high, this.high,
                                other.highElement ? other.highElement.nextElementSibling : null,
                                this.highElement);
    }
    return [lowUncovered, highUncovered];
  }

  getSize() {
    return this.high - this.low;
  }
}

const LOCK_STATE_ACQUIRING = Symbol("LOCK_STATE_ACQUIRING");
const LOCK_STATE_ACQUIRED = Symbol("LOCK_STATE_ACQUIRED");
const LOCK_STATE_COMMITTING = Symbol("LOCK_STATE_COMMITTING");
//const LOCK_STATE_COMMITTED = Symbol("LOCK_STATE_COMMITTED");

export class VirtualContent extends HTMLElement {
  #sizes = new WeakMap();
  #target;
  #toShow = new Set();
  #updateRAFToken;
  #postUpdateNeeded = false;
  #intersectionObserver;
  #mutationObserver;
  #resizeObserver;
  // The inner container allows us to get the size of the scroller without
  // forcing layout of the containing doc.
  #outerContainer;
  #innerContainer;
  #emptySpaceSentinelContainer;

  #innerRect;
  #scrollerBounds;
  #revealedBounds;
  #attemptedRevealedBounds;

  #lockState = new WeakMap();
  #toUnlock = new Set();
  #justUnlocked = new Set();

  #elements = new WeakSet();
  #locking = new Set();
  #unlocking = new Set();

  #totalMeasuredSize = 0;
  #measuredCount = 0;

  constructor() {
    super();

    const shadowRoot = this.attachShadow({mode: 'closed'});
    shadowRoot.innerHTML = TEMPLATE;
    this.#emptySpaceSentinelContainer =
        shadowRoot.getElementById('emptySpaceSentinelContainer');
    this.#outerContainer =
        shadowRoot.getElementById('outerContainer');
    this.#innerContainer =
        shadowRoot.getElementById('innerContainer');
    this.#innerRect = this.#innerContainer.getBoundingClientRect()

    this.#intersectionObserver =
        new IntersectionObserver(this.#intersectionObserverCallback);

    this.#mutationObserver = new MutationObserver((records) => {this.mutationObserverCallback(records)});
    this.#resizeObserver = new ResizeObserver(this.resizeObserverCallback);
    this.#intersectionObserver.observe(this);

    // Send a MutationRecord-like object with the current, complete list of
    // child nodes to the MutationObserver callback; these nodes would not
    // otherwise be seen by the observer.
    this.mutationObserverCallback([{
      type: 'childList',
      target: this,
      addedNodes: Array.from(this.childNodes),
      removedNodes: [],
      previousSibling: null,
      nextSibling: null,
    }]);
    this.#mutationObserver.observe(this, {childList: true});

    // `capture: true` helps support the nested <virtual-content> case. (Which
    // is not yet officially supported, but we're trying.) In particular, this
    // ensures that the events handlers happen from outermost <virtual-content>
    // inward, so that we remove invisible="" from the outside in. Then, by the
    // time we get to the innermost node, all of its parents are no longer
    // invisible="", and thus it will be rendered (allowing us to accurately
    // measure its height, etc.)
    this.addEventListener(
        'activateinvisible', this.onActivateinvisible, {capture: true});

    this.scheduleUpdate();
  }

  setTarget(offset) {
    this.#target = offset;
    this.scheduleUpdate();
  }

  update() {
    this.#updateRAFToken = undefined;

    if (this.#postUpdateNeeded) {
      console.warn("Update reached while postUpdateNeeded");
      this.scheduleUpdate();
      return;
    }

    console.log("update");
    if (this.#locking.size || this.#unlocking.size) {
      console.log("update bail");
      return;
    }

    console.log("update continue");
    if (this.#target === undefined) {
      this.updateToInitial();
    } else if (this.#target.element) {
      this.updateToElement(this.#target);
    } else {
      this.updateToOffset(this.#target.offset);
    }
    let promises = [];
    for (const element of this.#toUnlock) {
      promises.push(this.unlockElement(element));
    }
    this.#toUnlock.clear();
    Promise.all(promises).then(() => {this.schedulePostUpdate()});
  }

  schedulePostUpdate() {
    this.#postUpdateNeeded = true;
    setTimeout(() => {this.postUpdate()}, 0);
  }

  postUpdate() {
    this.#postUpdateNeeded = false;
    DLOG("postUpdate");
    for (const element of this.#justUnlocked) {
      this.measure(element);
    }
  }

  measure(element) {
    let oldSize = this.#sizes.get(element);
    if (oldSize === undefined) {
      oldSize = 0;
      this.#measuredCount++;
    }
    let newSize = element.clientHeight;
    this.#totalMeasuredSize += newSize - oldSize;
    this.#sizes.set(element, newSize);
  }

  getScrollerBounds() {
    if (!this.#scrollerBounds) {
      let rect = this.getBoundingClientRect();
      this.#scrollerBounds = this.rectToRange(rect);
    }
    return this.#scrollerBounds;
  }

  updateToInitial() {
    if (!this.childNodes.length) {
      return;
    }
    this.requestReveal(this.firstChild);
    this.#revealedBounds = new Range(0, this.getSize(this.firstChild), this.firstChild, this.firstChild);
    let toReveal = this.getScrollerBounds().minus(this.#revealedBounds);
    DLOG("toReveal", toReveal);
    for (const bounds of toReveal) {
      if (bounds) {
        this.tryRevealBounds(bounds);
      }
    }
    this.#target = new Offset(this.firstChild, 0);
  }

  rectToRange(rect) {
    // TODO: allow horizontal scrolling.
    return new Range(rect.y, rect.height);
  }

  tryRevealBounds(bounds) {
    if (bounds.lowElement) {
      this.revealHigher(bounds);
    } else if (bounds.highElement) {
      this.revealLower(bounds);
    } else {
      this.revealBoth(bounds);
    }
  }

  requestReveal(element) {
    if (!element.displayLock.locked) {
      console.log(element, "is already unlocked");
    }
    this.#toUnlock.add(element);
  }

  revealLower(bounds) {
    this.revealDirection(bounds, /* lower */ true);
  }

  revealHigher(bounds) {
    this.revealDirection(bounds, /* lower */ false);
  }

  revealDirection(bounds, lower) {
    let startElement = lower ? bounds.highElement : bounds.lowElement;
    let pixelsNeeded = bounds.high - bounds.low - this.getSize(startElement);
    for (const element of this.findElements(startElement, pixelsNeeded, lower)) {
      this.requestReveal(element);
    }
  }

  findElements(element, pixelsNeeded, lower) {
    console.log("element", element);
    let elements = [];
    while (pixelsNeeded > 0) {
      elements.push(element);
      pixelsNeeded -= this.getSize(element)
      element = lower ? element.previousElementSibling : element.nextElementSibling;
      console.log("element", element);
      console.log("pixelsNeeded", pixelsNeeded);
    }
    return elements;
  }

  getSize(element) {
    let size = this.#sizes.get(element);
    return size === undefined ? this.getAverageSize() : size;
  }

  getAverageSize() {
    return DEFAULT_HEIGHT_ESTIMATE;
  }

  revealBoth(bounds) {
    let firstElement = this.firstChild;
    let elements = this.findElements(firstElement, bounds.low, /* lower */ false);
    let startElement = elements ? elements[-1] : firstElement;
    let elementsToReveal = this.findElements(startElement, bounds.getSize(), /* lower */ false);
    for (const element of elementsToReveal) {
      this.requestReveal(element);
    }
  }

  getScrollerHeight() {
    const numElements = this.children.length;
    return this.#totalMeasuredSize + (numElements - this.#measuredCount) * getAverageSize();
  }

  updateToOffset(offset) {
  }

  updateToElement(target) {
  }

  short(e) {
    return e.innerText.substr(0, 3);
  }

  #showElement = (e) => {
    /*
    this.#toShow.add(e);
    this.#toShow.add(e);
    this.#scheduleUpdate();
    */
  }

  #intersectionObserverCallback = (entries) => {
    /*
    for (const {target, isIntersecting} of entries) {
      // Update if the <virtual-content> has moved into or out of the viewport.
      if (target === this) {
        this.#scheduleUpdate();
        break;
      }

      const targetParent = target.parentNode;

      // Update if an empty space sentinel has moved into the viewport.
      if (targetParent === this.#emptySpaceSentinelContainer &&
          isIntersecting) {
        this.#scheduleUpdate();
        break;
      }

      // Update if a child has moved out of the viewport.
      if (targetParent === this && !isIntersecting) {
        this.#scheduleUpdate();
        break;
      }
    }
    */
  }

  unlockElement(element) {
    const state = this.#lockState.get(element);
    if (state === LOCK_STATE_ACQUIRED) {
      this.#lockState.set(element, LOCK_STATE_COMMITTING);
      this.#unlocking.add(element);
      return element.displayLock.updateAndCommit().then(
          () => {
            this.#lockState.delete(element);
            this.#unlocking.delete(element);
            if (this.#elements.has(element)) {
              this.#justUnlocked.add(element);
              this.scheduleUpdate();
            }
          });
    } else {
      DLOG(element, "while unlocking lock state", state);
    }
  }

  removeElement(element) {
    // Removed children should have be made visible again. We stop observing
    // them for resize so we should discard any size info we have to them as it
    // may become incorrect.
    this.#resizeObserver.unobserve(element);
    this.unlockElement(element);
    this.#sizes.delete(element);
    this.#elements.delete(element);
  }

  lockElement(element) {
    const state = this.#lockState.get(element);
    if (state === undefined) {
      this.#lockState.set(element, LOCK_STATE_ACQUIRING);
      this.#locking.add(element);
      console.log("acquiring", element);
      return element.displayLock.acquire({ timeout: Infinity, activatable: true }).then(
          () => {
            // console.log("acquired", element);
            // console.log("locked", element.displayLock.locked);
            this.#lockState.set(element, LOCK_STATE_ACQUIRED);
            this.#locking.delete(element);
            if (this.#elements.has(element)) {
              this.scheduleUpdate();
            }
          });
    } else {
      DLOG(element, "while locking lock state", state);
    }
  }

  addElement(element) {
    // Added children should be invisible initially. We want to make them
    // invisible at this MutationObserver timing, so that there is no
    // frame where the browser is asked to render all of the children
    // (which could be a lot).
    this.#elements.add(element);
    this.#resizeObserver.observe(element);
    return this.lockElement(element);
  }

  mutationObserverCallback(records) {
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.removeElement(node);
        }
      }

      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          this.addElement(node);
        } else {
          // Remove non-element children because we can't control their
          // invisibility state or even prevent them from being rendered using
          // CSS (they aren't distinctly selectable).

          // These records are not coalesced, so test that the node is actually
          // a child of this node before removing it.
          if (node.parentNode === this) {
            this.removeChild(node);
          }
        }
      }
    }

//    this.#scheduleUpdate();
  }

  resizeObserverCallback() {
  }

  onActivateinvisible(e) {
  }

  scheduleUpdate() {
    if (this.#updateRAFToken !== undefined)
      return;

    this.#updateRAFToken = window.requestAnimationFrame(() => {this.update()});
  }

}
