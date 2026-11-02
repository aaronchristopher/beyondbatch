# Reply in the original Outlook email

The initial desktop target is **Classic Outlook for Windows**. The desired production interaction is: request → Reply in Outlook → the relevant customer message in installed Outlook → user replies normally. Internal request IDs never need to appear in the subject. Other pilot users' Outlook versions should be checked during setup.

## Implemented in this slice

The UI has a Reply in Outlook action on request detail and draft preview. The current sample-only site shows the connection requirement instead of inventing a working email URL. The server projection supports a verified source-email web link with separate per-user mailbox/evidence checks. Opening a source or preparing text never changes response status, stops a clock or closes a request.

Microsoft Graph's documented `webLink` opens the specific message in **Outlook on the web**, where the user chooses Reply or Reply All. It is not a documented external-browser-to-desktop launch URL or a guarantee that Outlook expands an entire conversation. The fallback deliberately preserves the real message context; `mailto:` is not substituted.

## Production source contract

After authorizing the request, the repository resolves the selected relevant unanswered customer message to an accessible mailbox copy. It supplies `request.replySource` with internal tenant/request IDs; the Graph immutable message ID and mailbox ID; actual observed `webLink`; `provenance:'microsoft_graph'`, `selectionStatus:'verified'`, `purpose:'customer_reply'`, `direction:'inbound'`, `isDraft:false`; and current authorized `readableByPrincipalIds`. The authenticated principal supplies current `outlookMailboxIds` independently of its executive/task-summary grants. These are server-loaded scopes, never accepted from browser or model input. The current Entra loader still needs this evidence-access integration; no live capability is implied.

When several threads or mailbox copies are plausible, resolve or review that choice rather than opening the newest internal forward. Refresh moved/deleted-source links from Microsoft using the correct mailbox/immutable ID; unavailable evidence must remain visible. Recheck source access at click time in the production action endpoint. A displayed source link does not grant Exchange access; Outlook authenticates the actual user and enforces its own mailbox rights.

Initial link validation supports Microsoft's documented HTTPS `/owa/` message form on exact `outlook.office.com` or `outlook.office365.com` hosts, with `ItemID` and `viewmodel=ReadMessageItem`. Unknown forms require explicit validation before support is expanded. It never synthesizes message IDs, custom protocols, redirects, new compositions or Graph reply drafts. No `Mail.ReadWrite` or `Mail.Send` is required by this source-opening behavior.

## Classic Outlook desktop integration — still to build and test

A signed, locally installed Windows companion is the planned bridge from the external browser to Classic Outlook. After authenticated launch authorization, a single-use short-lived reference identifies the permitted mailbox copy. The companion resolves the matching Outlook profile/store and opens the item with the documented Outlook Object Model `GetItemFromID(EntryID, StoreID).Display()`. Graph immutable IDs, Exchange entry IDs and local store IDs are not interchangeable; translation/mapping and actual profile access must be verified.

The companion must accept only its narrowly defined launch action, reject arbitrary commands/URLs and expired or replayed references, and verify the signed-in user. It displays the original item; the human chooses Reply/Reply All and sends in Outlook. A denied or unavailable local item falls back to the authorized web link, without granting new mailbox rights. Do not expose a desktop capability in the UI until this path is installed and tested on a pilot PC. No companion, protocol handler, registry change or Outlook add-in has been installed by this work.

An Outlook add-in can use `displayMessageFormAsync` inside the Outlook host, but a normal external website cannot call that API. It is not by itself the external-browser launch bridge. New Outlook requires a different approach because it does not support the classic Outlook Object Model/MAPI path.

## Acceptance

- From a PM request, opening Outlook preserves the correct source customer/message/account; no ticket ID or new subject is inserted.
- A partial reply satisfies only its addressed obligations after Sent evidence is observed; clicking the link or saving a draft satisfies none.
- Internal forwards are not used as the customer-reply target without an explicit reviewed selection.
- Unauthorized/shared-mailbox/executive-only cases expose no source link; actual Outlook mailbox access is still required.
- Desktop pilot proves correct message selection across two accounts and shared-mailbox cases, failure fallback, and no silent auto-send before enabling the native button.

Official references:
- https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0
- https://learn.microsoft.com/en-us/office/vba/api/outlook.namespace.getitemfromid
- https://learn.microsoft.com/en-us/office/vba/api/outlook.mailitem.display
- https://learn.microsoft.com/en-us/javascript/api/outlook/office.mailbox
