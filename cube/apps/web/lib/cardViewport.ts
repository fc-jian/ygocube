// One observer for all mounted cards; do not read files or start image requests
// until a card approaches the viewport (including nested scroll containers).
const pending = new Map<Element, () => void>();
let observer: IntersectionObserver | undefined;
export function observeCardViewport(element: Element, ready: () => void): () => void {
  if (typeof IntersectionObserver === 'undefined') {
    ready();
    return () => {};
  }
  observer ??= new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const callback = pending.get(entry.target);
      pending.delete(entry.target);
      observer!.unobserve(entry.target);
      callback?.();
    }
  }, { rootMargin: '240px' });
  pending.set(element, ready);
  observer.observe(element);
  return () => {
    pending.delete(element);
    observer?.unobserve(element);
  };
}
