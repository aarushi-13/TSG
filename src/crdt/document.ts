import type { JSONContent } from '@tiptap/core'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProsemirrorJSON } from '@tiptap/y-tiptap'
import type { YjsDocumentSession } from '../persistence/yjsStore'
import { createDocumentSchema } from '../editor/extensions'

export const CONTENT_FIELD = 'default'
export const CONTENT_INITIALIZED_KEY = 'tsg-content-initialized'

/** Keep this schema aligned with the editor schema: Y.XmlFragment encodes ProseMirror nodes. */
export function initializeSharedContent(session: YjsDocumentSession, initialContent: JSONContent): void {
  const initialized = session.doc.getMap<boolean>('tsg-document-metadata')
  const fragment = session.doc.getXmlFragment(CONTENT_FIELD)
  if (initialized.get(CONTENT_INITIALIZED_KEY)) return

  // A non-empty fragment can be present from an update received before the marker.
  // In that case mark it initialized without importing the legacy JSON over it.
  if (fragment.length === 0) prosemirrorJSONToYXmlFragment(createDocumentSchema(), initialContent, fragment)
  initialized.set(CONTENT_INITIALIZED_KEY, true)
}

export function readSharedContent(session: YjsDocumentSession): JSONContent {
  const raw = yXmlFragmentToProsemirrorJSON(session.doc.getXmlFragment(CONTENT_FIELD)) as JSONContent
  return createDocumentSchema().nodeFromJSON(raw).toJSON() as JSONContent
}
