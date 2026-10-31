import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'

const rect = new DOMRect(0, 0, 120, 24)
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
Object.defineProperty(HTMLElement.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => rect })
Object.defineProperty(Range.prototype, 'getClientRects', { configurable: true, value: () => [rect] })
Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => document.querySelector('.ProseMirror') ?? document.body })
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => undefined })
Object.defineProperty(window, 'scrollBy', { configurable: true, value: () => undefined })
