# BICII Admin — Design tokens and primitives

Staff-facing tasks on these screens: [USER-GUIDE.md](USER-GUIDE.md).

The Admin has to look like it belongs to BICII. Its tokens start from the
public site's `src/app/globals.css` (palette, dust ramp, Archivo + Inter,
spring easings, two-tone focus ring, `.gutter` / `.eyebrow` / `.measure`)
and add an operational layer the public site does not need. Everything lives
in [`src/app/globals.css`](../src/app/globals.css) as Tailwind 4 `@theme`
tokens, so each one is also a utility class (`bg-waiting`, `text-dense`,
`min-h-tap`).

To see them: `npm run dev`, open `/dev/ui` (development only; it 404s in
production builds).

## Brand layer (ported verbatim)

| Token | Value | Use |
|---|---|---|
| `ink` | `#050707` | Text, borders, solid buttons |
| `paper` | `#fbfaf7` | Page background, `themeColor` |
| `red` `yellow` `sky` `indigo` `green` | wordmark accents | Fills only, except indigo (10.37:1 on paper) |
| `dust-100…700` | warm neutral ramp | `dust-500` = secondary text (4.95:1 paper, 4.54:1 dust-100); `dust-300` only on ink |
| `font-display` / `font-sans` | Archivo / Inter (next/font, variable) | Uppercase Archivo for labels and buttons |
| `ease-spring` `ease-soft` `ease-pop` `ease-glide` | spring curves | Press-compress, sheets, toasts |

## Operational layer (Admin only)

**Surfaces**, back to front: `paper` (page) → `sunken` (= dust-100: wells,
table headers) → `card` (white, with a `hairline` = dust-200 border).

**Status** maps onto the five accents. Each status has four tokens:

| Status | Accent | Solid fill + text | Ratio | Soft fill + text | Ratio |
|---|---|---|---|---|---|
| `waiting` | yellow | `bg-waiting text-waiting-fg` (ink) | 12.16:1 | `bg-waiting-soft text-waiting-deep` | 5.62:1 |
| `progress` | sky | `bg-progress text-progress-fg` (ink) | 8.00:1 | `bg-progress-soft text-progress-deep` | 5.77:1 |
| `done` | green | `bg-done text-done-fg` (ink) | 6.42:1 | `bg-done-soft text-done-deep` | 5.38:1 |
| `danger` | red | `bg-danger text-danger-fg` (paper) | 4.71:1 | `bg-danger-soft text-danger-deep` | 5.67:1 |
| `info` | indigo | `bg-info text-info-fg` (paper) | 10.37:1 | `bg-info-soft text-info-deep` | 8.53:1 |

Never put ink text on red (4.11:1). The `-deep` steps also pass as text on
paper (6.1–6.8:1), so `text-danger-deep` is the error-message colour. Domain
code maps its enums onto these five (e.g. `waiting_parts` → waiting,
`ready` → done, overdue → danger) and always shows the text label with the
colour.

**Density**: `text-dense` is 13px on a 20px line, for tables and line items;
pair money and quantity columns with `tabular-nums`. Inputs stay at 16px so
iOS does not zoom on focus.

**Tap targets**: `--spacing-tap` is 44px (`min-h-tap`, `size-tap`). Every
interactive primitive meets it; buttons are 48px by default as on the public
site.

All ratios come from `npm run tokens:contrast` (`scripts/contrast.mjs`), which
fails if a documented text pair drops under 4.5:1 or a UI pair under 3:1.
Change a colour → rerun → update the comments in `globals.css` and this table.

## Primitives (`src/components/ui/`)

Server components unless they need state or browser APIs.

| Component | Notes |
|---|---|
| `Button`, `ButtonLink`, `SubmitButton` | solid / outline / accent / ghost / danger; sm / md / lg; `pending` sets aria-busy, disables, shows a spinner; press-compress. Labels never wrap unless `wrap` is set (a long label in a phone-width footer or card, e.g. with `w-full sm:w-auto`), so a long label never widens the page. `SubmitButton` (client) reads `useFormStatus`. |
| `IconButton` | `aria-label` is required by type. |
| `Field` (client) | Label, hint, error, required marker. Provides context so the control inside gets `id`, `aria-describedby` (error, hint), `aria-invalid`, `required`. |
| `Input`, `Textarea`, `NumberInput` (client) | `NumberInput` is `type="text"` + `inputMode` (decimal for money, numeric for a whole-number quantity); values stay strings — parse with `lib/money`. Optional −/+ steppers. A quantity with `decimals` (job lines and intake services take 2, for 1.5 hours of labour) gets the decimal keypad, and its steppers add or take 1 in decimal arithmetic, keeping the fraction. Kind `decimal` with `stepper` moves by `step` (default 1; printer offsets use 0.5 mm), rounded to the step's decimals, clamped to `minValue`/`maxValue`, never "-0": the steppers are how an iPhone enters a negative value (its decimal keypad has no minus key). |
| `Checkbox`, `Switch` (client) | Checkbox is native and styled; Switch is `role="switch"` for settings that apply immediately. |
| `Sheet` (client) | Modal dialog: bottom sheet on phones, right panel at `md`+. Inerts the rest of the page, traps Tab, Escape closes, focus returns to the opener. `dismissible={false}` while a commit is pending. Without a footer the body pads for the iPhone home indicator. While open it moves toasts above its footer (`--toast-inset-bottom`). On a phone it sits above an on-screen keyboard: `visualViewport` sets `--keyboard-inset` and `--visual-height`, which lift the panel and cap its height (audit U1-5; not yet checked on an iPhone). |
| `ToastProvider`, `useToast` (client) | Polite live region for confirmations, `role="alert"` for errors (errors persist until dismissed). Mounted in the root layout. On phones it sits above the tab bar (never over Scan); an open Sheet lifts it above its Save/Cancel row. Optional `action` (`{ label, onAction }`, e.g. "Retry" on a failed upload) adds one button that runs it and dismisses the toast; toasts with an action stay until dismissed and are never pushed out (at most four show; a new toast pushes out the oldest plain one). Optional `key`: a toast with the same key replaces the one on screen in place (one "3 photos not saved" per record, not one per photo); `dismiss` takes the id or the key. The provider outlives navigation, so a Retry still works after the screen that failed was left. |
| `Badge`, `StatusPill` | Tone = the status tokens; pills always carry text. |
| `Card`, `EmptyState`, `Skeleton`, `Spinner`, `PageHeader` | Layout and feedback. `Card` never clips (no `overflow-hidden`), so pickers, menus and focus rings inside it can extend past its edge; flush content rounds its own corners. Its header wraps: an action too wide to sit beside the title (a half-width card on iPad) moves under it rather than squeezing it, and several actions wrap among themselves (a job's Add service, Add part, Add manual line on a phone). |
| `RowList`, `RowLink` | Edge-to-edge list of tappable rows (More, Settings, Staff; later jobs, products, customers). Rows use the inset focus ring and round their own first/last corners; the list does not clip. |
| `SearchPicker` (client) | ARIA 1.2 combobox + listbox; async `search(query)` (may be a Server Action), debounce, stale-response guard, ↑/↓/Enter/Escape, hidden input for forms. `action` adds a last option ("Create new customer") reached with the arrows and Enter like any result. Optional pickers (`clearable`, default `!required`) can go back to nothing: a 44px clear button, emptying the field and leaving it, or Escape on an empty field; `onSelect(null)` reports it. Inside a `Sheet` (`InSheetBodyContext`, `src/components/ui/sheet-context.ts`) the results take space in the flow and are scrolled into view, because the sheet body clips an absolute popup behind its footer when the sheet is short (Add part on a phone); elsewhere they float under the input. SPEC §22: use it instead of any large `<select>`. |
| `Chip`, `ChipRadioGroup` (client) | A 48px choice chip: a toggle button (`aria-pressed`) for several choices. `ChipRadioGroup` for one choice (the intake's lead, Assign's who, the board's mechanic filter): a radio group with one Tab stop (the chosen chip, or the first) and Arrow / Home / End moving and choosing, like `SegmentedControl`. |
| `Select` (client) | A native select styled like `Input`, wired by `Field`. Only for short fixed lists (fewer than 15 options: a service's category); anything that grows uses `SearchPicker`. |
| `SegmentedControl`, `Tabs` (client) | Radiogroup and tablist with roving tabindex and arrow keys. A segment can be `disabled` (`aria-disabled`, skipped by the arrow keys, ignores clicks, muted text and a not-allowed cursor); say why next to the control (photo visibility: never public on a customer record, or for an undecoded original). Each state has its own class branch: `cn()` does not resolve conflicting utilities. `value={null}` is a choice with no default (the charge bearer, D4): nothing is checked, the hidden input is empty and the first enabled segment takes the Tab stop. |

Class strings are joined with `cn()` (`src/lib/cn.ts`), which does not merge
conflicting utilities; prefer a variant prop over overriding colours with
`className`.

## Focus

The global ring (`:focus-visible`: 3px indigo outline, 3px offset, paper
halo) is drawn outside the element. Anything full-bleed inside a clipping
or edge-to-edge container uses the **inset** variant, the `focus-inset`
utility (`globals.css`): the same two tones drawn inside the element, so no
ancestor's `overflow` can cut it. Used by `RowLink`, `Tabs` and
`SegmentedControl` (both scroll horizontally, which clips vertically too).
Never add `overflow-hidden` to a container of focusable rows to get rounded
corners; round the first and last rows instead.

## Forms

The pattern every Server Action form follows (`staffAction` +
`useActionState`, `src/lib/actions.ts`):

- React resets uncontrolled fields after every form action, success or
  not. A failed action returns `values` (the submitted text fields, never
  passwords or other secrets, `src/lib/form-data.ts`); render them back as
  `defaultValue={values?.field ?? ""}` so nothing typed is lost. Passwords
  are re-entered.
- Errors: `error` above the form (`role="alert"`), `fieldErrors` on each
  `Field`. `useFocusFirstInvalid(state)` (ref on the `<form>`) moves focus to
  the first invalid control after a failed submit.
- Controls that apply immediately (switches) use the action directly with
  `useOptimistic` and a toast, not a form.
- Create/edit forms live in a `Sheet` whose body is mounted only while it
  is open (`CustomerSheet`, `BikeSheet`), so every opening starts clean.
  The submit button sits in the sheet footer, outside the `<form>`, and
  points at it with `form={formId}`; it takes `pending` from
  `useActionState`. The action wrapper passed to `useActionState` handles
  success (toast, close or `router.push` to the new record).
- A form that creates a record carries its own id (`newId()`,
  `src/lib/uuid.ts`, made when the sheet opens) as the idempotency key: a
  repeated submit finds the row it already created (the domain treats the
  primary-key conflict as success) instead of making a second customer or
  bike. `newId()` falls back from `crypto.randomUUID()` (secure contexts
  only) to `getRandomValues()` for an iPad on a plain-http LAN address.
- A form that appends a permanent record (a timeline note, a Cult Commons
  rate) carries a `newId()` key the same way, and the RPC replays on it, so
  a retry after a lost response never writes the record twice.
- An edit sheet over text other people also edit (a job's details) sends
  only the fields its user changed; the RPC keeps the rest (null keeps), so
  a colleague's newer text is not overwritten with this page's older copy.
- One-tap buttons that stay in place while what they do changes (a job's
  status buttons, whose first slot is the next step) are disabled for
  400 ms after each change (`useArmedAfter` in `src/components/ui/use-armed.ts`),
  so the second tap of a double tap cannot take the button the first one
  revealed. A final step (marking a job collected) is never one tap.
- Destructive or commit steps (deactivate staff; later stock, payment and
  settlement reversals) are two steps: the first button opens a confirm
  block that asks for the reason (SPEC §22), puts focus in the reason field,
  places the confirm button in a different position with a different React
  `key` (so the first button's DOM node and focus are not reused), and
  ignores clicks for 400 ms after opening (a double tap). See
  `AccessControl` in `settings/staff/[staffId]/staff-controls.tsx`, and
  "Delete photo" in the photo viewer.
- A confirmation without a reason field (archive a customer or bike,
  `ArchiveControl`) puts focus on Cancel and keeps its confirm button
  *disabled* for 400 ms rather than silently ignoring an early press, so
  a double tap cannot confirm and nothing seems to swallow a click.
  Archiving is reversible (Unarchive is one press) and deletes nothing.

## Loading

- Sections whose pages need nothing beyond `requireStaff()` have a
  `loading.tsx` rendering `RouteLoading` (skeletons in an `aria-busy`
  region): it is prefetched, so a tap shows the new screen's skeleton at
  once.
- A loading boundary makes the response stream, which commits it to HTTP
  200 before the page runs (Next docs, `loading.js` "Status Codes"): a page
  under it that calls `forbidden()` or `notFound()` shows the right UI with
  a 200. So permission-gated subtrees (`/settings/staff`, `/reports`) have
  none, nor do the group root (`/`) and `/settings` (whose subtree includes
  `/settings/staff`), keeping their real 403s. `/reports` has no
  `loading.tsx` anywhere: `/reports/lines` answers a real 403 without View
  financial reports, and `/reports` streams each section in its own
  `<Suspense>` after `requireStaff()` instead ([Reports](#reports)).
  Today does the same (audit U1-2): after `requireStaff()` it renders its
  greeting and three section skeletons at once (`TodayLoading`, with a
  "Loading the day…" status), and the dashboard streams in behind one
  `<Suspense>`.
- Every nav link (tab bar, rail) marks its icon while its navigation is
  pending (`LinkPending`, `useLinkStatus`), which also covers the sections
  without a `loading.tsx`.
- The print view (`/print/labels/[jobId]`, route group `(print)`, outside
  the app shell: no tab bar, rail or header) has no `loading.tsx`; its
  layout and page both call `requireStaff()`, so a signed-in customer or
  deactivated staff member gets a real 403. Its toolbar, its details block
  and the toast region are `print:hidden`, so printing it prints the labels only, one per
  page of `@page { size: <w>mm <h>mm; margin: 0 }`. `/labels` and
  `/labels/[jobId]` have `loading.tsx` like other record sections;
  `/settings/labels` (admins only) has none, keeping its real 403.
- `/shopify` and everything under it (admins only, D86) have no
  `loading.tsx`, so a non-admin gets a real 403.
- `/q/[shortId]` has no `loading.tsx` on purpose: its job is a server
  `redirect()`, which must happen before anything streams.
- `/settings/schedule` and `/settings/appointment-types` need only
  `requireStaff()` (every staff member reads the schedule; only admins
  see edit controls, never a 403), so each has its own `loading.tsx`
  like `/settings/profile`; `/settings` itself still has none.
- Record pages (`/customers/[id]`, `/bikes/[id]`) have their own
  `loading.tsx`, so opening a row shows the record skeleton at once. An
  unknown or malformed id renders the not-found screen (with a 200 status,
  as above).
- Search-as-you-type changes only `?q=`: the page segment keeps its React
  state (Next keys segments without search params), so the field keeps
  focus and caret, the old results stay until the new ones arrive (the
  navigation is a transition), and the field shows a spinner meanwhile.

## Printing

- The print view `/print/labels/[jobId]` is in the `(print)` route group,
  outside the app shell; its toolbar, the toasts and every other bit of
  chrome are `print:hidden`, so printing prints the labels only, one per
  page of `@page { size: <w>mm <h>mm; margin: 0 }` taken from the job's
  template snapshot.
- Only one compact row is sticky (Back to the record, the status and
  **Print** / **Open PDF**). The title, the size line, the hint and the
  confirmation are in the page's flow above the labels: with its reason
  open the confirmation is taller than a phone screen, and a sticky block
  cannot scroll, so a sticky confirmation hid **Mark as failed** below the
  fold (Phase 8 review).
- Browser printers: **Print** calls `window.print()` synchronously inside
  the click (iOS Safari drops the gesture after an `await`), then records
  the job as sent. PDF printers (the way to print from an iPhone or iPad):
  **Open PDF** in a new tab, then Share → Print, paper at the label size,
  scale 100%.
- Browsers cannot report whether the printer succeeded, so every job ends
  with staff confirming "Yes, all printed" or "Something went wrong…" with
  a reason (D59); unconfirmed jobs wait under Labels → To confirm.
- Finished jobs (printed, failed) are never rendered again: Print again is
  a link back to the record that opens the print sheet for a new job
  linked by `reprint_of_id`, with a fresh preview.
- The printer is remembered per device (`localStorage`
  `bicii.label-printer.v1`); everything printed (text, price, QR) comes
  from the database (`label_preview`, then the job's snapshot). Every QR
  URL the Admin shows is the database's (`getQrBase` / `qrUrl` or the
  label content), never the environment's.

## App shell (`src/components/shell/`)

| Piece | Notes |
|---|---|
| `TabBar` (client) | Phones (< md): fixed bottom bar, Today · Jobs · **Scan** · Inventory · More. Scan is a raised 64px yellow disc. Pads for `env(safe-area-inset-bottom)`; pages pad their bottom to clear it. |
| `SideRail` (client) | md and up: sticky labelled rail with the mark, the four primary sections (Scan in yellow) and every More destination this staff member can open (`moreItemsFor`: admin-only ones, Shopify, for admins only; the staff layout renders it through the server `StaffSideRail` under `Suspense`, whose fallback is the rail without them). |
| `AppHeader` | Sticky; mark (phones only), `HeaderSearch`, and `ProfileChip` (initials → `/settings/profile`) streamed in `<Suspense>`. Clears `env(safe-area-inset-top)`. |
| `HeaderSearch` (client) | The global search field ("Search customers, bikes, jobs and stock"): a `next/form` GET form to `/search?q=` (works before hydration), remembered in recent searches on submit; a query that is exactly a short ID in any case ("p-000123") opens the record straight away through `/q/{id}` instead (`shortIdJump`, `src/lib/search.ts`; still remembered); `/` focuses it from anywhere on a keyboard. On `/search` it steps aside for the page's own field. |
| `nav.ts` | Single source for tabs, More items and active-state matching. |
| `ComingSoon` | `PageHeader` + `EmptyState` naming the phase that builds a section. |
| `StatusScreen` | 401/403/404/500 pages. |
| `ServiceWorkerRegistration` | Registers `public/sw.js` in production builds only. |

## Domain components (`src/components/domain/`)

Built from the primitives for one kind of record or job; Client Components
unless noted. They call Server Actions, never Supabase (except the photo
upload itself, below).

| Component | Notes |
|---|---|
| `SearchField` | Search box whose query lives in the URL (`?q=`, `src/lib/search-params.ts`): typing updates it after 300 ms with `router.replace` in a transition, Enter at once; other params (`archived`) are kept; back/forward and links update the field, but its own search arriving late never overwrites what was typed since (it remembers what it sent). A search still waiting for the pause is dropped when a link is clicked or the field unmounts, so it cannot pull staff back to the list. Pages render results on the server; lists say "First 30 matches" and how to narrow it when there are more. Used by `/customers`, `/bikes`, `/search`. |
| `ArchivedFilter` (server) | Active / Archived links for a list page, keeping `?q=`. The Archived list searches with `staff_search(…, archived => true)`, so a query matches exactly as on the active list. |
| `ShortId` (server) | A human short ID in monospace, never wrapped; `large` is the identity header of a record (the number on the bike's label). `ShortIdLink` links the chip with a 44px (`--spacing-tap`) hit area from a transparent `::before` overlay, so a standalone chip link (job part lines, stock movements) meets the tap floor without changing the row. |
| `CustomerSheet`, `NewCustomerButton`, `EditCustomerButton` | New/edit customer. Creating opens the new customer's page. |
| `BikeSheet`, `NewBikeButton`, `EditBikeButton` | New/edit bike. A new bike's owner is preset (from a customer's page), picked (`CustomerPicker`), or none (shop and consigned bikes). The edit form has no owner: ownership changes only by transfer. Creating opens the bike, ready for photos. |
| `TransferOwnershipButton` | Sheet: new owner (a customer via `CustomerPicker`, or the shop) and a required reason, kept in the bike's ownership history. The current owner is listed but not choosable. |
| `CustomerPicker` | `SearchPicker` over active customers (`staff_search`), via a Server Action. `allowCreate` (New sale, Book appointment; audit U1-3) adds the "New customer “…”" action, which opens `CustomerSheet` over the sheet and chooses the new customer, as intake does. |
| `ArchiveControl` | Archive (confirmed) / unarchive a customer, bike, service, product (refused while public or holding stock) or consignor (refused with items for sale or a balance other than 0, D47; the toast carries the mapped refusal with D46's remedies), with what archiving does in a sentence. |
| `CaptureButton` | The camera control for every photo (intake reuses it): "Take photo" (`<input type=file accept="image/*" capture="environment">`, opens the rear camera on phones) and "Choose photos" (library, several at once). Each file is decoded with its EXIF orientation (`createImageBitmap(…, { imageOrientation: "from-image" })`, `<img>` fallback), scaled to at most 2048 px on the long edge and re-encoded as JPEG 0.85 (`prepare-photo.ts`, sizing in `src/lib/images.ts`); re-encoding also drops EXIF, GPS included. A file the browser cannot decode (HEIC outside Safari) is uploaded as is when it is an accepted photo type. Then: a signed upload URL from the server, upload with the browser Supabase client straight to Storage with byte progress, record. Optimistic thumbnails with status and progress; up to two photos in flight. The queue lives above the pages (`PhotoUploadsProvider` in the staff layout, `upload-store.ts`), so uploads finish after leaving the record and their tiles are there again on coming back. A failure keeps the photo and its preview on its tile (Retry, Discard); one error toast per record ("3 photos not saved", Retry all) updates in place and is never pushed out; the header shows "N photos not saved" on every screen, linking to the record; closing or reloading the tab while any photo is unsaved asks first. Retry resumes at the failed step: once the object is in Storage only recording is retried (unless the server says it is missing). Photos are labelled "New photo 3", not by file name (iPhone captures are all image.jpg). A file Storage refuses (type, size) is not retried and says to save it as JPEG. The page refreshes once when a record's queue drains, not once per photo (each refresh re-signs every photo). A photo picked before hydration is picked up when React attaches. An undecodable original keeps its metadata, so it is recorded without dimensions and can never be made public. |
| `PhotoGrid` | A record's photos: thumbnails (visibility badge when not internal) that open `PhotoViewer`, with `CaptureButton` under them (hidden for archived records). A thumbnail is the photo's 480 px square rendition (`Photo.thumbUrl`) where Storage resizes images (`STORAGE_IMAGE_TRANSFORMS`), else the original; the viewer always shows the original. |
| `ReasonConfirm` | The two-step destructive pattern with a required reason (below, "Forms"), shared by voiding a line and cancelling or reopening a job: focus in the reason field, the confirm button in a new position with a new key, presses ignored for 400 ms, and a dismiss button that returns focus to the first button. The dismiss button says what it keeps where "Cancel" would be ambiguous: "Keep job" beside "Cancel job", "Keep line" beside "Void line", "Back" for a reopen. `onConfirmingChange` lets a sheet hide its own submit while the confirmation is open. The first button's label ends with "…"; `startAccessibleName` gives it a distinct name where a list has one per row ("Delete the Tue 13 Oct closure…"). |
| `LeadPicker` | The lead mechanic as `ChipRadioGroup` chips ("Me" first, Unassigned last), shared by the intake's People step and appointment check-in. |
| `IntakeWizard` | `/jobs/new` (SPEC §7.1): one step at a time with "Step 2 of 5" and a progress bar, Back/Next as 48px buttons kept above the tab bar, Enter advancing on a keyboard (not in a textarea, a picker or a sheet). Customer (one `SearchPicker` over customers and bikes; a bike selects its owner; "New customer" opens `CustomerSheet` with `onCreated`), Bike (the customer's active bikes as large cards with an "Open job J-…" chip; "Add bike" opens `BikeSheet` with the owner preset and `onCreated`), Work (requested work, condition on arrival), People (lead as single-select chips, "Me" first, Unassigned allowed; additional staff as toggles; active staff only, D22), Services (chips by category, a filter above 12, −/+ quantity, a preview subtotal and, only with view_costs, a Cult Commons preview), then Review with Edit per section. It owns the job's and each service line's `newId()` key, so a double tap or retry makes one job. Draft: `src/lib/intake-draft.ts`, one per device under `bicii.intake-draft.v1` (ids, labels, typed text; guarded like recent searches), offered back as "Continue the intake you started at 10:42?" / Discard, cleared on success; Continue drops services no longer offered and staff no longer active (they could not be seen or removed, and the job would be refused every time) and says what it removed. A bike whose owner is archived is "Owned by … (archived)", never a shop bike: choosing it says to unarchive the owner or transfer the bike. If the bikes cannot be loaded, an error with "Try again" replaces the skeleton. The progress bar has one segment per counted step, full at "Step 5 of 5". Rendered only in the browser (the draft is in localStorage). |
| `JobStatusActions` | The usual next steps (`primaryActions`) as large buttons with a toast, disabled for 400 ms after every status change (the next step's button lands under the finger). "Collected…" is final (D15), so it opens a confirmation naming the job and the customer, focus on Back, "Mark collected" disabled for 400 ms; when the customer paid (`paid`, from `paidSummary`, D154, D161) it first says, in semibold, "$60.00 was paid online. Take only $85.00." (or "…paid at the counter…", or "$345.00 was paid ($300.00 online, $45.00 at the counter). Take only $35.00.", or "…That is $35.00 more than the job total; take nothing more.", or "$135.00 was paid online. Nothing is left to pay; take nothing." when balance_due is 0, `nothingLeft`); while Stripe confirms a payment (processing_online, never in net_paid or the balance) it names no amount to take: "$50.00 was paid online." then "Stripe is still confirming $Z paid online, so $Y still to pay may already be covered. Press Check with Stripe before taking anything." (also when nothing is paid yet), or, when nothing is left to take anyway, the take-nothing sentence then "$Z paid online is being confirmed by Stripe; don't take it again.", from `collectedNotes`. "Change status": a sheet listing the other allowed moves (`allowedTransitions`) with nothing pre-selected, an optional note and, when Collected is picked, the same sentence and that it is final; plus Reopen and Cancel as `ReasonConfirm` (D15, D16), during which the sheet's own submit is hidden. D149b, D149c: with approved or ordered indent items (`settle`, from the page), a move out of the open statuses, by button or by Change status, opens `SettleItemsSheet` instead and the button reads "Complete…", "Ready for collection…"; Change status's Cancel section says to cancel those items too and its "Cancel job…" opens the checklist; a move refused by the database for them (a stale page, `work_order_has_unfitted_requests`) toasts, refreshes and opens it. Nothing for a collected or cancelled job. |
| `SettleItemsSheet` (`settle-items-sheet.tsx`) | The checklist before a job leaves the open statuses (D149b, D149c(1)): title "Before completing J-…", "Before marking J-… ready", "…collected" or "Before cancelling J-…" (`settleTitle`), description "Fit or cancel each approved or ordered item first." or, cancelling, "Cancel each approved or ordered item first. A cancelled job can't keep items waiting." (`settleDescription`). One row per approved or ordered item: "{qty} × {description} · {line total}", a done "Approved" or info "Ordered · PO-… · Arrived / Not arrived yet" `Badge`, the deposit badge ("Deposit paid" shown too), an "Open PO-…" link for Manage purchasing; Fit (or Add to job) and "Cancel item…", which open the shared `FitSheet` and `CancelSheet` (`indent-sheets.tsx`) over it; Cancel only when cancelling the job (a line would block it, D16) and, on a job completed before the guard, `notFittedNote` instead of Fit. The list comes from the page, so each Fit or Cancel refreshes it in place; with none left a done panel "All settled." The footer's Back and the move's own button ("Complete job", "Mark ready", "Collected…" → the Collected confirmation), disabled until the list is empty; cancelling ends in a `ReasonConfirm` "Cancel job…" in the body, disabled until then; a stale cancel refused for items toasts "Cancel the job's approved and ordered items before cancelling it." (`CANCEL_UNSETTLED_REFUSAL`, never the mapped "Fit or cancel…"). A note typed in Change status is kept and sent with the move (Back drops it). An open quote is named: "Completing the job withdraws the quote sent …: the customer's link will say it was withdrawn, and its 2 items go back to Proposed." (`quoteWithdrawNote`, D149c(2)). A sheet opened over it restores the checklist's toast inset when it closes, so the toasts its Fit and Cancel raise stay clear of the footer. |
| `LineTable` | A job's lines, dense (`text-dense`, `tabular-nums`): description, qty, unit price, total, and with view_costs unit cost, yield and Cult Commons per line. Its layout follows its own width (container queries: 28rem without costs, 42rem with), not the screen's, since the lines card is narrow on an iPad; narrower, each line is a stacked row. Voided lines stay, struck through with who, when and why, behind "Show voided". Each live line of an open job has `VoidLineControl`. A manual line added without a cost shows a "Cost pending" badge to everyone (D14), and "—" as its unit cost. |
| `VoidLineControl` | "Void…" on a line: `ReasonConfirm` calling `voidLine`. A part line's confirmation says what goes back to stock; a line a fitted indent item became (D160, `fittedIndentLines` from the job page through `LineTable`'s `indentLines`) first says "Voiding puts <part> back to approved: fit it again or cancel it before completing the job." (or "back to ordered"), and its toast is "<part> is back to approved". |
| `AddServiceButton` / `AddServiceSheet` | `SearchPicker` over active services (price and category shown), quantity with steppers, the price prefilled and editable by anyone (D14), the cost field only with view_costs, a live line-total preview; the sheet's `newId()` line key makes a repeat submit add one line. Disabled with "Completed jobs are locked. Reopen to change lines." once the job is completed. |
| `ManualLineButton` / `ManualLineSheet` | Description, quantity, unit price and (view_costs only) cost, with the same preview, key and lock. Left without a cost, the line is marked cost pending (D14); the sheet says so (to view_costs holders: "Enter 0 when there is no direct cost"). |
| `IndentCard` (`indent-card.tsx`) | The job's "Indent parts and quote" card (Phase 13, ADR-024), after the lines: the quote's state in one line ("Quote sent … by WhatsApp, waiting for the customer. The link works until …", "Quote answered by <name> on …", expired, withdrawn), then one row per live request (description, kind, quantity × quoted price, with cost access the expected supplier and cost, the line total and a status `Badge`; an ordered part adds "On PO-… · Arrived / not arrived yet") with Fit / Add to job (`canFit`) and Cancel (`CANCELLABLE`); an approved or ordered item whose fitted line was voided (D160) adds a waiting-tone line, `unfittedNote` ("Its line was voided, so it is not on the bill: fit it again or cancel it.", or for a part bought outside BICII that it went back into stock, to fit from stock), and its Fit sheet replaces the never-ordered note with `BACK_IN_STOCK_NOTE`. Under it "Send quote (N items)" (or "Send again" while a quote is open: sending withdraws the open quote first, so its items are offered again), "Withdraw quote", and "Order approved parts" for Manage purchasing. Sheets: Propose part (`SearchPicker` over shop-owned quantity products; "New product" with Manage inventory creates it first through `create_product`; expected cost and `Supplier` select only for cost holders, D60/D147), Propose service, Send quote (checkboxes with an `<output>` total; WhatsApp only when `whatsappNumber` accepts the customer's phone and Email only when quote emails are set up and the customer has an address, each absence said in a line under the control; validity 1–30 days), Quote ready to send (the link once, `CopyText`, the prefilled `quoteMessage`, and "Emailed to …", "The email didn't go out…" or an "Open WhatsApp" `wa.me` link; the link is never stored, D143), Order (supplier preset from the request, "Move the job to Waiting on parts" on), Fit (`FitSheet`, shared with the settle checklist in `indent-sheets.tsx`: the quoted total; warns when its order has not arrived, when the part was never ordered in BICII (`neverOrderedNote`, D23), and, to view_costs holders, when its product has no cost: a danger callout with a link to the product and Fit part disabled, D24; D149a: for an approved part never ordered, to cost and purchasing holders (`canBuyOutside`), a `SegmentedControl` "Where it comes from", **From stock** or **Bought outside BICII**, the second showing **Cost each** (money, prefilled with the expected cost, hint "What the shop paid for one, from the receipt. It becomes this product's cost." and "Expected when proposed: $28.00."), **Bought from** (optional, 100 characters, "Not the price."), "Records 1 × <part> as bought outside BICII at <location> and fits it now. The stock count there doesn't change, and the job's yield uses this cost.", "Cost 1 × $30.00 = $30.00", and **Record and fit** ("Recording…"), enabled even when the product has no cost; a stock fit refused with `part_cost_missing` switches to it, says so in a waiting panel and focuses Cost each) and Cancel (`CancelSheet`, reason). On a job that is no longer open (R-082, D149): Propose, Send, Withdraw, Order and Fit are hidden; an approved or ordered item shows a danger "Not fitted" badge instead of its status (never the green done tone), its "Deposit paid" badge, and `notFittedNote`: on a completed or ready job "Not on the bill: the job was completed before this was fitted. Reopen the job with Change status to fit it, or cancel it." with Cancel for anyone; on a collected or cancelled job "Not on the bill, and it can no longer be fitted: the job is collected. An admin or manager can cancel it and refund any deposit in Stripe." with Cancel for admins and managers only (`canCancelRequest`, `canCancelClosed`), whose sheet adds "The job is closed and stays closed; refund any deposit for it in Stripe."; an item on a quote left open shows a neutral "Not answered" badge (`requestBadge`) and the quote line says the customer can no longer answer it, then `unansweredQuoteNote`: on a completed or ready job "Reopen the job with Change status to withdraw it or send it again.", on a collected or cancelled job "An admin or manager can cancel its items, which withdraws it.", where admins and managers get Cancel on it (D149), the sheet says cancelling it withdraws that quote and its other items go back to Proposed, and the toast reads "<part> cancelled. The quote was withdrawn." The card's anchor is `#indent-parts`. Words and links are pure in `src/lib/indent.ts`. Phase 14 (D152): an approved or ordered part whose answered quote asked a deposit that is not paid adds a second `Badge` ("Deposit due" or "Being confirmed", waiting; "Deposit refunded", info; from `quote_deposits.part_request_ids`). In the Order sheet those parts (`depositBlockedIds`, the SQL gate's mirror) start unticked and read "2 × <part> (deposit not paid)"; without `canOverrideDeposit` (an active admin or manager) they are disabled with "Parts whose deposit isn't paid can be ordered once the customer pays, or by an admin or manager." under them, which each disabled checkbox names with `aria-describedby`; with it, ticking one shows a waiting callout "The customer hasn't paid the deposit for N of these parts." and a required `Textarea` "Why order before the deposit is paid?" (hint "Recorded on the job's timeline.", 500 characters), and the submit becomes **Order without deposit**: the sheet is the confirm step of the two-step reason rule. The reason is sent only when such a part is chosen; the toast says "…without the deposit". The product page's Stock card lists arrived, unfitted indent quantities as "N reserved for jobs" with `ShortIdLink`s to the jobs (`indent_reservations`, D146: shown, never held). |
| `TotalsSummary` (server) — the job yield panel | The compact summary row under the lines (SPEC §22, not a modal): the running sale total for everyone; with view_costs also Cost, Yield, Cult Commons (with the rate when every line shares it) and BICII yield after Cult Commons, from `work_order_totals_staff`, marked "Provisional" while a live line has no cost entered (D14), with what to do about it. It is PLAN Phase 5's job yield panel (no second economics block): for view_costs holders the job page also reads `work_order_yield` (`getWorkOrderYield`, in its `Promise.all`) and passes it as `report`, which labels Cult Commons with the lines' snapshot rates ("30%", or "25–30%" when they differ, `formatRateRange`), adds the loss note shared with Today ("1 line sold at a loss: −$15.00. Losses don't reduce Cult Commons on other lines.", D1) and says when the job counts in reports: "Counted in reports on Sat, 3 Oct 2026 (completed)" from its current completion (D32), "Counted in reports once the job is completed" while open or after a reopen, or "Not counted in reports (cancelled)" on a cancelled job (final, D15; never recognised, D32). Without view_costs: the sale total only, and no recognition text anywhere on the page. Phase 14 (D154, D161): when money is held for the job, online or at the counter, or Stripe is still confirming a payment, the Lines card adds one semibold line under it (`paidSummary`, aria-label "Paid and still to pay"), "Paid $… · Still to pay $…", with "($A online, $B at the counter)" when both, "· Paid ahead $…" on an open job or "· Paid above the bill $…" on a completed or ready one, and "· $Z being confirmed by Stripe" in the waiting tone; the first part a link to the Customer payments card (`#customer-payments`), because the total above it does not include that money; on a collected or cancelled job "Paid $… · $… more than the bill" (`held_over_total`). R-082: approved indent items not on the bill are a waiting-tone memo under the total, a link to the indent card (`#indent-parts`): "Approved, not on the bill yet: N items, $X. Fit them to bill them." while the job is open, "Approved but never fitted: $X (not billed)." after (`unfittedMemo` over `work_order_unfitted_requests`); never part of the total, yield or Cult Commons. |
| `Timeline` (server, `job-timeline.tsx`) | A job's events newest first: `describeEvent` titles (`src/lib/workshop-timeline.ts`), notes and reasons quoted, the actor ("Recorded outside the app" when none) and the time. Payloads carry no costs. The page shows the newest 200 (`?events=all`: 1,000); when older ones exist it says so ("Earlier ones, including the check-in, are not shown") with "Show earlier events". |
| `PhotoViewer` | Sheet: the photo enlarged (tap for full size), who can see it (`SegmentedControl` Internal / Customer / Public, applied immediately with `useOptimistic` and a toast; each level explained; Public disabled on a customer record, PLAN D13, and on a job, D19; Customer and Public disabled on a consignment item, D52, with "Agreement photos show the consignor's terms, so they stay internal." shown once), caption, and delete with a reason (two steps; Cancel returns focus to "Delete photo…"). A change that went through but could not remove the old copy from Storage is reported as done, with "Finish" (toast and inline), not as a failure; the next showing of the record finishes it anyway. |
| `LinkSegments`, `GroupChips`, `ActiveFilterChips`, `JobRow` (server, `workshop-board.tsx`) | The board's pieces as links, so every view is a URL and works before hydration: the All / My jobs / Unassigned switch (styled like `SegmentedControl`, `aria-current` on the current one); the groups as a horizontally scrolling chip row with counts ("All open" first; wraps from `sm`); the active filters as removable chips (`Remove filter: …`) and "Clear"; and the job row (whole row tappable, ≥ 64px): J- number, `StatusPill` (text + tone), bike, customer, lead or "Unassigned" (waiting tone), age ("3 d") and, for D20, a solid danger "Overdue" badge with its word. No money on the board. |
| `BoardFiltersButton` / `BoardFilterSheet` | "Filters (n)": a Sheet with statuses as checkboxes under their board group (several at once, e.g. only "Waiting on parts", which the Waiting group otherwise merges with the customer and paused), mechanic chips ("Anyone" first; jobs they are on as lead or additional), customer and bike `SearchPicker`s (the intake search action), checked in (Any, Today, Last 7 days, Last 30 days; Singapore time) and age (Any, Over 3 days, Overdue). "Show jobs" writes them to the URL (`boardQuery`); Reset clears the sheet. |
| `AssignmentsCard` | The job's "People": the lead and "Also on the job", each with Remove (toast "… removed from the job"), and "Assign": a Sheet with active staff as radio chips (their current role noted) and Lead / Additional; choosing Lead says "Replaces <lead> as lead; they leave the job." (D22), moving the lead to Additional says the job will have no lead. Read-only on collected and cancelled jobs. |
| `ApprovalSwitch` | "Customer approved extra work": a `Switch` applied at once (`useOptimistic`, toast; it snaps back if refused) that keeps the stored note, with an optional approval note saved by its own button (shown only when changed); the note follows the stored one when the page brings a newer one. Hidden on collected and cancelled jobs, where the flag shows as a badge. |
| `NoteButtons` / `NoteSheet` | "Add note" and "Add diagnosis" (any status): a Sheet with one textarea (1–5,000 characters) that keeps what was typed when refused; the note is append-only, in the timeline, and the sheet's `newId()` note key makes a retry add one note. |
| `EditDetailsButton` / `DetailsSheet` | "Edit" on Requested work: requested work (required), condition on arrival, internal notes and completion notes; only the fields changed since the sheet opened are sent (a colleague's newer text elsewhere is kept); an emptied note is cleared; a failed save shows what was typed (`values`). One "… updated" timeline entry names what changed. |
| `JobHistoryList` (server) | A bike's service history and a customer's jobs, newest first: J- number, status, the first line of the requested work (with the bike on a customer's page), checked-in / completed / collected dates and the lead; each row opens the job. |
| `ServiceSheet`, `NewServiceButton`, `EditServiceButton` | manage_inventory: name, category (`Select`, "No category (Other)"), price, the cost only with view_costs (on edit, empty keeps the current cost), description, Active and Public switches; `newId()` key; values kept on failure (controlled state); the snapshot note; editing also offers `ArchiveControl` (kind `service`). |
| `CategoriesEditor` (`categories-card.tsx`) | manage_inventory: service categories with Rename (in place) and Archive, "New category", and archived ones with Unarchive. Written through the RLS client; never deleted. |
| `ScheduleRateButton` / `CancelRateButton` | Admin, D21. Schedule: a percentage (up to 2 decimals, converted exactly to the 4 dp fraction, `percentToRate`) starting Now or Later (a Singapore `datetime-local`, never past), then a second step in place saying it applies to lines added from then on and never changes existing lines; its confirm button is disabled for 400 ms and focus starts on Back; the sheet's `newId()` rate key makes a retried "now" one rate. Cancel (a future rate only): "Cancel…" opens a confirmation with focus on "Keep it" and "Cancel rate" disabled for 400 ms. |
| `StockBadge` (server or client, `stock-badge.tsx`) | A product's stock as a `Badge`: tone and words from `stockTone` / `stockLabel` (`src/lib/inventory.ts`): danger "Out of stock" or "−2 (recount needed)" (D23), waiting at or below the reorder point, done "34 in stock"; a unique product "2 available". `label` keeps the tone with other words: the part picker's "12 at Shop floor · 20 total", a part line's "37 left at Shop floor". |
| `RoleBadge` (server or client, `role-badge.tsx`) | A staff member's role as a `Badge` with its word (D90): Admin (info), Manager (progress), Mechanic (neutral). Used on Settings → Your profile and Settings → Staff. Your profile's card "Your role and access" puts it beside the title, then the role's one line (`ROLE_DESCRIPTIONS`), then one checked row per effective permission (label and description; an exception on top of the role carries an `ExtraAccessBadge` "Extra access" in the waiting tone, the same component as the staff list, D92), "Record refunds" for admins and managers (D94) and, for admins, "Admin settings"; a mechanic with nothing extra reads "Workshop access only: …". History reads the pre-D90 value "staff" as Mechanic (`roleLabel`). |
| `AdjustStockButton` / `AdjustStockSheet` | adjust_stock, counted products: location (`SegmentedControl`, each segment with its count, the default location first), Add / Remove, quantity with steppers, Adjustment / Damaged (Damaged disabled when adding), a required reason with quick-fill chips ("Stock count correction", "Found stock", "Damaged in workshop", "Opening stock count"), a unit cost when adding (view_costs only, optional), a live "Shop floor: 34 → 31" right under the quantity; a result below zero is shown there as an alert (the quantity marked invalid and described by it) and the submit disabled (insufficient_stock), so the reason is in view next to its cause on a phone. `newId()` request id made when the sheet opens. |
| `StockTransferButton` / `StockTransferSheet` (`stock-transfer-sheet.tsx`) | manage_inventory: From (locations holding stock, with counts), To (the other active locations), quantity (or the unit, fixed) and an optional reason; "Move stock". Not `transfer-sheet.tsx`, the bike ownership transfer. Counted products from the product page; a unit from its own page while available or reserved. |
| `ProductSheet`, `NewProductButton`, `EditProductButton` | manage_inventory. New: Quantity / Unique first (read-only afterwards), name, SKU, brand, category (`Select` of `product` categories), description, sale price, cost (view_costs only; on edit, empty keeps it), reorder point (counted only), Active. Unique adds the first unit on the same sheet (`UnitFields`: location, serial, "Condition (shown publicly when published)", unit sale price, unit cost with view_costs, and an optional "This is a complete bike" `SearchPicker` over shop bikes with no owner and no unit, saying customer bikes must be transferred first); both the product and the unit carry their own `newId()`, and a refused unit leaves the product, whose page offers Add unit (the swallowed failure is still logged, at error level when it is not a refusal). With Unique chosen and no active location, Add product is disabled (the unit fields show `NoActiveLocation`); Quantity stays possible. Creating opens the product. |
| `AddUnitButton` / `AddUnitSheet`, `EditUnitButton`, `WriteOffUnitControl` (`unit-sheet.tsx`) | Add unit: `UnitFields` with the unit id as key. Edit details (manage_inventory): serial, condition (public once published), own price, cost (view_costs; empty keeps), internal notes. Write off (adjust_stock, units in stock): `ReasonConfirm` whose request id is made when the confirmation opens. |
| `AddPartButton` / `AddPartSheet` | "Add part" beside Add service and Add manual line, locked the same way (D15). A `SearchPicker` over saleable stock (archived, inactive, customer-owned and unavailable units left out; consigned stock offered since Phase 6 step 3, D27 as changed, D44; a unique product found by name offers its available units), each option with name, P-/U- number, SKU, price, a `StockBadge` and, for consigned stock, an info `Badge` "Consigned · <consignor>" (counted stock adds the FIFO-head C- number, D45) and a note in the sheet that the consignor is owed their agreed amount once the job is completed. Consigned counted stock never goes below zero: instead of the D23 warning the sheet says "Only N of this consigned item at <location>. Consigned stock can't go below zero." (the database refuses). Then a counted part: quantity with steppers and "Take from" segments with their counts (default location chosen); a unit: quantity 1 at its own location. The selling price, an optional "Price each" for anyone (D14; required when the part has none, D24), a cost and yield preview only with view_costs, a line total. More than the location holds shows the non-blocking D23 warning ("Only 1 at Shop floor. Adding 2 takes the count below zero; …"). Success toast "Added 2 × Road inner tube. 37 left at Shop floor." With no active location, the sheet (like Adjust stock, the unique part of New product and the product page's Stock card) shows `NoActiveLocation`: "No active stock location. Ask someone with inventory access to add one in Settings → Locations", the last words linking to `/settings/locations`. |
| `MovementList`, `HistoryList` (server, `movement-list.tsx`) | Movements newest first: signed quantity first (tabular, `text-done-deep` in, `text-danger-deep` out, a real minus sign), the label (`movementLabel`: "Used on job", "Returned from job", "Adjustment", "Damaged", "Transfer in/out", "Received"), the J- link and `#id`, the product and unit (linked; left out on the product's own page), location · actor · time (Singapore), the reason quoted, "Reverses #n" / "Reversed by #m" anchors to `#movement-{id}` (to the movements list when the other row is not on the page), and the unit cost only when the DTO carries it. `HistoryList` renders product and unit events through `describeProductEvent` / `describeUnitEvent` (`src/lib/inventory-history.ts`): "Cost changed" never shows a value; a unit's job-driven status reads "Put on job J-…", "Sold when J-… was completed", "Back on hold: J-… was reopened". |
| `PublicationControls` (`publication-card.tsx`) | The product page's Publication card (D26): status pill and what it means; the manual moves as buttons from `publicationActions` (over `manualPublicationTargets`): Make internal, Publish, Unpublish, Archive listing, Restore; never Sold; a sold product offers only Archive listing with "Sold items return to public automatically if the sale is reversed."; no Publish for a unique product without an available unit. Buttons are keyed by status and disabled for 400 ms after each change (`useArmedAfter`). While not public: "Publishing needs" with a tick or cross per requirement (`publicationChecklist`: a name, a sale price, a public photo, and for unique products an available unit, computed from the loaded data; the database stays the authority), Publish disabled and described by "Still needed: …". Refusals (`publication_requires_*`, `publication_sold_by_sale`) show their mapped message inline and as a toast. Then the QR label URL (`CopyText`) and `PublicPreviewPanel`. Moves only for manage_inventory; everyone sees the status, URL and preview. |
| `PublicPreviewPanel` (server or client, `public-preview.tsx`) | "What the public sees": the record's `reporting.public_items` row as staff read it (name, price, availability, condition for a unit, the public photo count), or "Not public. Anonymous scans show nothing." Read-only, also on the unit page. |
| `CopyText` | A value as selectable monospace text with Copy (Clipboard API; without it, e.g. plain http on a LAN iPad, it selects the text and says to copy it). The QR URL comes from the one server helper `src/lib/qr.ts` (`qrUrl`), never from an env read in a page. |
| `QrLabelUrl` (server or client, `qr-label-url.tsx`) | "QR label URL" on the product's Publication card and the unit's Public listing card: `CopyText` of `qrUrl(shortId)` (`shop_settings.public_site_url` + `/q/` + the short ID, D9), or, when the address is missing or malformed, a danger `StatusPill` "QR address not set" with "Labels can't be printed until the shop's public website address is set." and, for admins, "Set it in Labels and printers" (`/settings/labels`), else "Ask an admin to set it." |
| `LabelSvg`, `LabelSheet` (`src/lib/printing/label-svg.tsx`, `adapters/browser.tsx`; server or client) | One label as SVG from `composeLabel`'s drawing (mm viewBox, white, the QR as one path, Helvetica/Arial text, the short ID in Courier; `role="img"` named "Label: {name}, {price}, {short id}"; printer offsets inside a clip of the label). `LabelSheet`: the job's copies as `[data-label]` boxes of exactly the label size with `data-qr-payload`, page-broken between them; on screen a wrapping grid with "1 of 10" under each and, above 20 copies, "+ N more identical labels" (the rest print but stay hidden); copies after the first reuse the first through `<use>`. |
| `PrintJobProvider`, `PrintJobAction`, `PrintJobHint`, `PrintJobConfirmWhenSent`, `PrintJobControls`, `PrintJobConfirm` (`print-job-controls.tsx`) | The print view's controls for an open job (D59), as parts sharing one state (`PrintJobProvider`) so the view keeps only the action (`PrintJobAction`, md) in its sticky toolbar and the hint and the confirmation in its flow; `PrintJobControls` stacks them all in one place. Browser printer: **Print** that calls `window.print()` synchronously in the click (iOS Safari drops the gesture after an await), then marks the job rendered without waiting; PDF printer: **Open PDF** (a plain link, new tab) with "Open the PDF, then Share → Print. Set the paper to 58 × 40 mm, scale 100%."; a job already rendered asks at once. `PrintJobConfirm` ("Did all N labels print correctly?", "Did the label print correctly?" for one; focus moves to it when it appears, scrolled clear of the toolbar): **Yes, all printed** (disabled for 400 ms after it appears) → toast "Marked as printed" with "Back to P-…" and "Print history"; **Something went wrong…** → `ReasonConfirm` ("What went wrong?", **Mark as failed**, **Back**). Never creates a job. Also on an open job's history page, without moving focus. |
| `PrintJobOutcome` (`print-job-outcome.tsx`) | A finished job on its print view: "Printed {when} by {who}" (done tone) or "Failed: {reason}" (danger), "This print job is finished…", **Print again** (a link to the record with `?print=1&qty=…&reprint=…`; a disabled button with the archived sentence for an archived record) and **Print history**. |
| `PrintLabelButton`, `PrintLabelSheet` (`print-label.tsx`) | "Print label" (outline, printer icon) in the header of a counted product, a unit and a bike, and in their Labels card (SPEC §16: open the record → Print label → how many → printer → print). Disabled, with the reason beneath it (`aria-describedby`), when the record cannot get a label (archived, the QR address not set, no template). The sheet is mounted only while open, so each opening mints a fresh job id (`newId()`): title "Print labels · P-…" ("Print again · P-…" from a reprint link); the label as it will print (`LabelSvg` of `composeLabel`, at most 320 px wide, "58 × 40 mm · {template}"); "Not public yet: anyone who scans this label sees 'not found' until it is published." for an unpublished product or unit, "Bike tags are for the workshop…" for a bike, and for a reprint whose price differs "Price changed since that print ($45.00 → $39.90). These labels show the new price." (NULL is "no price", 0 is $0.00; D58); How many (`NumberInput` quantity, 1 to 500 for a product with chips 1, 5, 10, 20, 50; 1 to 10 for a unit or bike, "One label per unit…"; a request over the cap starts at the cap with "Prints 500 now; print again for the remaining 120.", D56); Printer (always a radio list, each printer with its hint, "This device's print dialog" / "Opens a PDF to share or print": printer names are long, and a segmented row of two scrolled the PDF printer off a 390 px screen; preselected: the reprinted job's, else this device's last one, else the default); Label size (a `SegmentedControl` up to four, a radio list above) only when the kind has more than one active template. Footer: Cancel and **Print 10 labels** ("Starting…"); success opens the print view, a refusal keeps the values and shows the error (`role="alert"`), `print_job_conflict` mints a new id and links the record's print jobs. With a preset (the page's `?print=1&qty=N&reprint=…`) it opens once after hydration; closing it drops the parameters (`router.replace`), and printing from it replaces that history entry with the print view, so Back never reopens the sheet for another job. |
| print-sheet helpers (`src/lib/printing/print-sheet.ts`, pure) | `QUICK_QUANTITIES`; `readRememberedPrinter` / `rememberPrinter` (`localStorage` `bicii.label-printer.v1`, try/catch, UUID-checked: a per-device convenience, never data); `choosePrinter`, `chooseTemplate`; `priceChanged` (Decimal compare; NULL differs from every price, 0 included); `describeLabelPrice`; `initialQuantity` (the D56 remainder); `printButtonLabel`; `parsePrintParams` (the deep link). |
| `LabelsCard`, `HeaderPrintLabel` (server, `labels-card.tsx`) | The "Labels" card of a product, unit and bike page over `getLabelContext`, rendering whatever the label state is. Printable: the label as it prints now (default template), "The QR opens" with the database's payload as `CopyText` ("QR URL on the label"), Print label, "What the public sees" (an in-page link to the publication card's `PublicPreviewPanel`, products and units), and the waiting-tone "The price changed since the last printed label ($45.00 → $39.90). Reprint the labels on the shelf." (D58). Not printable: the disabled button with the reason; for the QR address an admin link to Labels and printers (others "Ask an admin…"); a unique product says its labels are its units' and links each U- (D57). Always: "Recent prints" (the last three jobs: status pill, "10 × · printer · who · when", each to `/labels/{id}`) and "All label jobs" (`/labels?q={short id}`). `HeaderPrintLabel` is the header's button and carries the deep-link preset. |
| `QrAddressForm`, `PrinterList` / `ProfileSheet`, `TemplateList` / `TemplateSheet` (`label-settings.tsx`) | Settings → Labels and printers (admins). `QrAddressForm`: "Change address" reveals the address field, checked with the database's rule (`publicSiteUrlInputSchema`) before **Review the change**, then a confirmation box ("Point new labels at …?": printed labels keep the old address, so keep a redirect there; the environment's address stays accepted by the scanner) with **Back** and **Change the address** (armed after 400 ms). `ProfileSheet`: name; printer type (Browser print / PDF download; Network and Bluetooth disabled until Phase 12), read-only once created; calibration offsets X and Y (`NumberInput` decimal steppers, 0.5 mm, −5 to 5); Active (`Switch`, disabled on the default with why); **Make default** when editing another printer. `TemplateSheet`: a live preview on sample content with the layout's problem under it (`role="status"`, the database's sentence, e.g. the QR does not fit; shown even before a name) and Save disabled while there is one; a field's own problem (no name, a size out of range) sits on that field (`error`, `aria-invalid`) once it was changed or Save was pressed, never on a form not touched yet, and a blocked Save moves focus to the first invalid field; name; kind (create only); width, height, QR size, margin (mm steppers); QR position Left / Right; fields as checkboxes in the canonical order (short ID always on: "Every label shows its short ID."); name lines 1 / 2 / 3; text size; Active; **Make default**. Rows are buttons (≥ 64 px) with Default and Off badges and, for templates, a mini preview. |
| `SplitToUniqueButton` / `SplitToUniqueSheet` | "Split off as unique item" on a counted product's Stock card, only for staff with adjust_stock and manage_inventory (D28): name (the product's), Take from (active locations holding stock, with counts), serial, "Condition (shown publicly when published)", sale price (the product's to start with) and a required reason (480 characters: the ledger adds "Split to U-…: "). The new product id and unit id are `newId()`s made when the sheet opens; success toasts "Split off as U-…" and opens the new unit. |
| `ChangeOwnerButton` / `ChangeOwnerSheet` | "Change owner" in a product's header, only for the admin role (D162; `staff.role === "admin"`, the action `admin: true`, the RPC `require_admin`), on an active, unarchived shop product counted by quantity. A sunken note says what moves ("Its N at <location> leave the shop's stock and are received as one consignment item", or that only the owner changes with no stock) and that it can't be changed back; stock at more than one location shows only a note asking for a transfer first, with no submit. Fields: Consignor (`ConsignorPicker`, existing consignors only), amount owed per item (the product's cost to start with) and asking price (its sale price), Received (today, sent as NULL), Reason (460 characters: the ledger adds "Reclassified as consigned stock: "). The item id is a `newId()` made when the sheet opens. Success toasts "C-… received from <consignor>" and opens the item; with no stock it toasts "Now consigned stock" and stays. |
| `PaymentsCard` (`payments-card.tsx`, client) | The job's "Customer payments" card (Phase 14, D151, D154-D156, D159b, D161), eyebrow "Online through Stripe, and at the counter"; not "Payments", which is consignor settlements' word. Rendered after `IndentCard` when `showsPaymentsCard` holds: a deposit, a Stripe payment or a counter payment exists, or Send payment link applies, or the viewer is an admin and the job is not cancelled (step3-critique C15); the anchor `#customer-payments` is what the Lines card's "Paid …" line links to. Header actions (`Card` `actions`, outline, small): **Send payment link** for any staff member while `canSendLink` holds (Stripe on, the job completed or ready for collection, SGD, at least S$0.50 still to pay, nothing being confirmed by Stripe), opening `SendBalanceLinkSheet`; **Record counter payment** for an admin (`canRecordCounterPayment`) on a job that is not cancelled, Stripe on or off, opening `CounterPaymentSheet`. In order: the `payment_issues` sentences (danger or waiting soft panels, the SQL's own words, as on Exceptions), keyed `${paymentId ?? counterPaymentId}:${issue}`; the live link's line in a sunken panel (`linkLine`: "Payment link sent 17 Oct 2026 by WhatsApp ($180.00 when sent), valid until 24 Oct 2026." or "…, expired …"); one row per deposit ("Deposit on the quote answered …", amount · percent, and a `Badge` from `depositBadge`: due and processing waiting, paid done, refunded info, none neutral, and a due deposit on a job that is no longer open "Part of the balance", neutral, since the balance already asks it), with "Stripe isn't set up, so the customer can't pay online…" on an open job's due deposit while Stripe is off; one row per completed or open Stripe payment ("Deposit", "Balance" or "Payment", `paymentStatusLabel` badge, amount, date, "of which $… refunded", "Refund pending in Stripe") with an outline **Check with Stripe** (when Stripe is on and the payment is pending, has a pending refund or an issue of its own, never for a counter issue; toasts "Stripe confirmed: …" with the card's own label, "Being confirmed" included, or "Nothing new from Stripe.", with a description when Stripe's payment or refunds could not be read) and, for admins and managers, a ghost "Open in Stripe" (new tab, `noreferrer`); failed and expired attempts collapse into "N earlier checkouts not completed"; the "At the counter" list (`CounterRow`, below); then the totals (`dl` "Payment totals", shown once the job has a Stripe payment, a counter payment, Stripe money being confirmed or a live link, `showsPaymentTotals`): "Paid online" (with "($… refunded)"), "Paid at the counter" when above 0, in the waiting tone "$Z paid online is being confirmed by Stripe; don't take it again." while `processing_online` is above 0, "Job total so far" (open) or "Job total", then "Still to pay", or on an open job "Paid ahead …. Indent parts join the job total when they're fitted.", or on a completed or ready job "Paid above the bill"; on a collected or cancelled job holding more than its bill, `heldOverSentence`, which names the source (online: "…Refund it in Stripe if it is due back…"; counter: "…If it is given back, an admin records it as given back…"; both: "Refund the online part in Stripe, or an admin records counter money given back…", R-082); the footer "Money held against this job, not a sale. Online refunds are made in Stripe; an admin corrects a counter payment by voiding it." No arithmetic: every figure is Postgres's. |
| `CounterRow` (in `payments-card.tsx`) | One counter payment in the card's "At the counter" list (D161, every staff member): "Deposit · Cash" or "Towards the bill · PayNow", the amount, "Paid 3 Oct 2026 · Ref R-12 · recorded by …", the note if any. A voided one is struck through (label and amount, dust) with "Recorded in error: <reason> · <who> · <when>" or "Given back: …". On a live one an admin gets two ghost small `ReasonConfirm`s, each with its own question, confirm and consequence (step3-critique C18): **Void (recorded in error)…** ("Why was it recorded in error?", **Void payment**: it no longer counts and Reports leave it out of the day it was taken; record it again if it was only wrong) and **Given back…** ("Why was it given back?", **Record as given back**: Reports keep it on its day and show it given back today; BICII moves no money); both dismiss with "Keep payment", the start buttons are named with the row ("Given back… Towards the bill $45.00, Cash"), and while one is open the other is hidden. No request id: void_counter_payment replays on the payment, its kind and its reason. Never expires a Checkout. |
| `SendBalanceLinkSheet`, `BalanceLinkSentSheet` (`balance-link-sheets.tsx`) | Copies of `SendQuoteSheet` / `QuoteSentSheet` for a payment link (D156; any staff member). Send: "Still to pay $X" (balance_due) and that the page always asks what is left at the time; "This replaces the link sent on 17 Oct 2026. That link stops working." in the waiting tone when a live link exists, or "This replaces the link sent on 1 Oct 2026, which expired on 8 Oct 2026." when that link is past its expiry (`replaces` {sentAt, expiresAt}, the same test as the card's `linkLine`); "Send by" `SegmentedControl` WhatsApp (only with a number `whatsappHref` can use) / Email (only when emails are on and the customer has an address, "The Admin emails the link to …") / Copy link, with a line for each missing channel; "Link works for (days)" `NumberInput` stepper 1–30, default 7, hint that it also stops at collection or a reopen; **Create link**. The link id is `newId()` made on open and sent again on a retry (a used id is refused: the token is shown once). Sent: title "Payment link ready to send", "This link is shown only now. If it is lost, send a new one."; "Emailed to …" (done) or "The email didn't go out. Copy the link and send it another way." (waiting, alert); the replaced link's Checkout note when it could not be expired or was paid meanwhile (waiting, alert); "It asks $X now and works until …"; **Open WhatsApp** (not when emailed) with `balanceMessage`; the link as `CopyText`; the message read-only. |
| `CounterPaymentSheet` (`counter-payment-sheet.tsx`) | Record counter payment (admins, D161; modelled on `SettlementSheet` and `RefundSheet`; step3-critique C19). "What it is for" radio cards: one per deposit that is due or refunded on a job that is not cancelled (`counterDepositChoices`: "Record the $300.00 deposit for the quote answered 12 Oct 2026", its amount fixed and shown as "Amount (the deposit)", never typed) and "Towards the bill" (chosen by default; Amount `NumberInput` money prefilled with balance_due when above 0, `counterPrefill`; its own error "Enter an amount above 0, like 12.50." or, above `COUNTER_MAX`, "At most $999,999.99.", and the start button stays "Record payment…" and disabled). "Paid by" `SegmentedControl` Cash / Card / PayNow / Bank transfer / Other (Cash first; "Card is the shop's own terminal and PayNow its own QR…"). "Paid on" date, max today, min the later of the check-in day (a deposit: the quote's answer) and 29 days back (`counterDayRange`); today sends NULL, an earlier day noon Singapore time or just after the check-in on that day (`counterReceivedAt`). Reference (hint "The receipt, terminal or PayNow reference, if any."), Note. Warnings that never refuse (`counterWarnings`, waiting tone): towards the bill while a deposit is due on an open job ("The customer's quote page still asks the full $300.00 deposit online…"); a deposit due on a completed or ready job ("The deposit stays 'due' on this card…"); an amount above still to pay on a completed or ready job ("This is $X more than still to pay; it will show as paid above the bill."); on an open job an info line instead. Two-step commit: the footer's "Record $3,800.00 cash…" (`counterCommitLabels`; "by card…", "by PayNow…") hides the footer and shows a confirm group at the top of the form ("Record $3,800.00 cash towards the bill on J-…? A wrong entry is corrected by voiding it."), clear of the toasts at the bottom of a phone's screen, focus on **Back**, **Record $3,800.00** disabled for 400 ms. The id is `newId()` made on open. A refusal shows above the form with everything kept, and focus moves to the first invalid field when it has field errors (DESIGN Forms; else back to the start button); success toasts "Recorded $X at the counter on J-…" and closes, unless the job's open Checkout could not be expired or was paid meanwhile: then a "Counter payment recorded" panel keeps that sentence (danger, alert) until **Done**. |
| `DepositPercentControl` (`deposit-percent-control.tsx`) | Settings → Customer payments (admins, D151, D157a), a copy of `AlertDaysControl`: `depositPercentLabel` ("No deposit is asked on indent quotes" or "Customers pay N% of the approved indent parts after answering") with Change; the sheet "Deposit on indent parts" explains it is asked after answering, on approved parts only, and that sent quotes keep theirs; a `NumberInput` 0–100 with the suffix "%" and the hint "0 asks for no deposit. Deposits under S$0.50 aren't asked (Stripe's minimum)." While Stripe is off the sheet says "Stripe is off, so only 0 can be saved." with the reason, the stepper stops at 0 and the Server Action refuses more. |
| `NewLocationButton`, `EditLocationButton`, `LocationActiveSwitch` (`location-controls.tsx`) | Settings → Locations (manage_inventory): a sheet with name, kind (`Select`: Shop floor, Workshop, Storage, Off-site) and sort order, the new location's `newId()` as its key; the Active `Switch` applies at once with `useOptimistic` and a toast, and a location still holding stock snaps back with the `location_has_stock` error toast. |
| `CameraPermission` (`camera-permission.tsx`) | The camera's state when there is no picture: Phase 0's messages (checking, allow, allowed, blocked with the iPhone Settings path, unsupported) plus "needs a secure connection" and "would not start", with "Allow camera" / "Try again" where pressing helps. `cameraErrorState` maps getUserMedia errors onto them. |
| `Scanner` (`scanner.tsx`) | The Scan screen; see "Scanning" below. |

### Sign-in

- **`/login`** (`src/app/(auth)/login/`, PLAN D10, D70): two steps on one
  page, no navigation between them, so it behaves the same in a browser
  tab and in the installed app (codes, never links). Step 1: Email
  (`autocomplete="email"`, email keyboard) and "Email me a code". Step 2:
  "Check your email", "If {email} belongs to BICII staff, we've emailed a
  6-digit code. It expires in 10 minutes." (identical for unknown and staff
  emails), Code (`inputMode="numeric"`, `autocomplete="one-time-code"` so
  iOS offers the code from Mail; a pasted "123 456" is accepted), "Sign
  in", "Send a new code" (disabled with a live "Send a new code in 0:59"
  countdown for 60 s after each send, counted on the device's clock; a
  resend says "We've sent a new code." in a polite status) and "Use a
  different email" (back to step 1, email kept). One action state for both
  steps (`signInStep` routes on `intent`), every form carries `next`.
  Errors show in one `role="alert"` above the step. Only an error about
  what was typed marks the field `aria-invalid` and points its
  `aria-describedby` at the alert: an email that is not an email, an
  email without access ("This email doesn't have access to BICII Admin.
  Ask an admin to invite or reactivate you."), a missing or malformed
  code, a refused code. "Too many attempts. Wait a minute and try again."
  and "Sign-in is unavailable right now…" mark nothing, because retyping
  cannot help. Focus goes to Code when step 2 opens or a code is refused,
  and to Email after an error there, either way. Asking again for an
  address Auth will not email yet (its per-address interval) shows "Check
  your email" exactly as for any other address (D70). The code is never
  echoed back. Under the form: "No access? Ask an admin to invite or
  reactivate you in Settings → Staff." Full-width 56px primary buttons, 48px secondary ones.
- **Invites** (Settings → Staff → Invite): an admin picks the Role in a
  `SegmentedControl` (Admin, Manager, Mechanic; Mechanic chosen first) with
  each role's one line listed under it, the chosen one in ink; anyone else
  reads "They join as a Mechanic." (D93). The success view says "{email}
  can now sign in.", "They join as a <Role>." and how (the email, then the
  emailed code; no password to hand over), with "Invite another" and "Set
  extra access" ("Open their page" for an admin).
- **Staff roles** (Settings → Staff, D90-D93). The list shows each
  person's `RoleBadge`, then a plain line for what the role includes ("All
  permissions", "Every permission except Manage staff", "Workshop access
  only"), then "· Extra:" and an `ExtraAccessBadge` per exception (the
  waiting tone, which no role uses, so an exception never reads as a
  role). The person
  page opens with the **Role** card: the role's label and one line; for an
  admin a `SegmentedControl` "Role" and an outline "Change role…" (off
  until another role is picked; on their own row every segment is
  disabled with "You can't change your own role." under it); others read
  "Only an admin changes roles.". "Change role…" opens a `Sheet` "Change
  <name> to <Role>?" listing what changes (`roleChangeSummary`: what the
  new role has, exceptions it includes and so removes, what is lost), an
  optional "Why?" textarea (`REASON_MAX_LENGTH`, 500) and "Change role",
  disarmed for 400 ms (`useArmed`). Focus starts on Cancel, as for other
  consequential confirmations whose reason is optional: the admin reads
  what changes before the phone keyboard can cover it. The change is sent
  with the role the sheet showed (`expected_role`); if someone changed it
  meanwhile, nothing changes and the sheet says "Someone changed their
  role in the meantime. Reload and try again." Any refusal shows as an
  alert in the sheet; success toasts "<name> is now a <Role>". The **Extra access** card states "Included in
  the <Role> role: …" in words and offers switches only for what the role
  does not include. History lines come from `describeStaffEvent`
  (src/lib/staff-events.ts): "Added as <Role>", "Role changed from <From>
  to <To>", "Extra access: <Permission> granted/removed".

### Inventory

- **Screens.** `/inventory` (search by P- number, SKU, name or brand;
  All · Low stock · Archived as links keeping `?q=`; rows with `StockBadge`
  and a publication pill when public or sold; New product for
  manage_inventory; a Movements link), `/products/[id]` (large P- number,
  publication pill, stock by location with the total, low-stock and
  "recount needed" notes, units for unique products, prices, photos,
  recent movements, history, archive), `/units/[id]` (large U- number,
  status, location, condition, serial, ownership, the bike and "On job
  J-…" / "Sold on job J-…", prices, photos, movements, history, write
  off) and `/inventory/movements` (product chip, location segments, kind
  chips All / Jobs / Adjustments / Transfers, "Load more" by `?before=`).
  Each has a `loading.tsx`; an unknown id is not-found. The Inventory tab
  and rail item stay active on `/products` and `/units` (`also` in
  `nav.ts`).
- **Permissions shown as absence.** Adjust stock and Write off need
  adjust_stock; Transfer, Edit details, Add unit, New product and Archive
  need manage_inventory; anyone may add a part to a job. Buttons a staff
  member cannot use are not rendered.
- **Cost and yield gating.** Products, units and movements have no column
  grant on their costs, so the domain lists columns (never `select *`) and
  reads cost, expected yield and Cult Commons from `product_costs`,
  `inventory_unit_costs` and `inventory_movement_costs` only for view_costs
  holders; the DTO otherwise has no such key. Product and unit pages show
  them under "Cost and yield (staff with cost access only)". A consigned
  product's row reads "Amount owed per item" (`effective_cost`: the amount
  owed on the consignment that sells next, D44) with "The cost of each
  sale: what the consignor is owed on the consignment that sells next.
  Change it with Edit terms on the item.", and its Edit details has no
  Cost field.
- **Selling prices** shown anywhere come from `public.selling_prices`
  (`private.selling_price`), never recomputed in TS, so Phase 6's
  consignment price flows through; edit forms edit the product default and
  the unit's own price.
- **Stock photos** are Internal or Public only (stock has no customer;
  `attachment_stock_never_customer`): "Public photos appear on the QR page
  once the item is published."
- **Parts on jobs.** A part line shows its P-/U- number (linked) and what
  is left where it came from; voiding says "Voiding returns 2 to Shop floor
  (a reversal is recorded; nothing is deleted)." and toasts "Returned to
  stock"; a reopen of a job with a unit line adds "U-000001 goes back on
  hold for this job. To return it to stock, void its line after
  reopening." (D25); the timeline reads "Used 2 × … (P-…) from Shop floor"
  and "Returned 2 × … to Shop floor".
- **Publication card** (`PublicationControls`, after Prices and Units on
  the product page): status, the manual moves, the requirement checklist
  with Publish disabled until all are met, the QR label URL with Copy and
  "What the public sees". The unit page has a read-only "Public listing"
  card: "Listing follows P-… (its product's publication status)", a link
  to change it there, its QR URL and its own `public_items` row.
- **Split off as unique item** sits with Adjust stock and Transfer on a
  counted product's Stock card (both permissions); the new item is a draft
  at the same location and keeps the source's cost (D28).
- **Change owner** sits in the product header beside Edit details, for
  admins only (D162); a consigned product's header line adds "·
  Consigned stock" after how it is counted.
- **Locations settings** (`/settings/locations`, listed in Settings): the
  services-settings pattern: readable by every staff member, with its own
  `loading.tsx` (no permission gate below it; `/settings` itself keeps
  none), edit controls only with manage_inventory. Rows show kind and sort
  order, a "Default" pill on the default location (active, lowest sort
  order, then name: `listLocations`' `defaultLocationId`) and "Inactive";
  Add and Edit open a sheet, Active is a switch applied at once. Nothing is
  deleted; a location holding stock cannot be switched off.
- **Customer payments settings** (`/settings/payments`, listed in
  Settings for admins only, after Labels and printers; Phase 14 step 2,
  D157): admin only with no `loading.tsx`, so the 403 is real. Three
  cards. **Stripe**: a `StatusPill` with "Live", "Test mode" or "Fake
  Stripe (development and tests only)" and, when on, the webhook endpoint
  (monospace, selectable), the pinned API version and the seven event
  types to subscribe; when off, a danger "Off" pill and the reason as a
  sentence that names the variable, never its value
  (`STRIPE_OFF_REASONS`); a danger `role="alert"` box when a deposit is
  asked while Stripe is off; a link to the runbook. **Deposit on indent
  parts**: `DepositPercentControl`. **Recent Stripe deliveries**
  (`#deliveries`, the Exceptions link target): the newest 20 rows, each the
  event type (monospace), a status pill (Applied done, Needs attention and
  Rejected danger, others neutral), the time, the outcome or rejection in
  words, the delivery count above 1, and a link to the job.
- **Product categories settings** (`/settings/product-categories`, listed
  in Settings between Services and Locations): the same `CategoriesEditor`
  as the service categories card, with `kind="product"`, inside a
  "Categories" card for manage_inventory; a plain list for everyone else.
  Its own `loading.tsx`. The product page's Edit details keeps an archived
  category the product is filed under as "<name> (archived)", as the
  service sheet does, so saving never drops it; New product's Category
  field says where to add categories while there are none.
- **Bike stock card**: a bike that is a unique unit shows a "Stock" card on
  its page, "In stock as U-000001 · Available" (`unitStatusLabel`; "Stock
  unit U-… · Sold" once it has left stock) linking to the unit, with the
  note that it cannot go to a customer or be archived while in stock. The
  transfer sheet and `ArchiveControl` show the `bike_in_stock` message when
  that is refused.

### Consignment

Phase 6 step 3 (SPEC §13; D4, D44–D48, D50–D52). Every screen is readable
by every active staff member; consignment money (balances, amounts owed,
charges, payments, history, agreement photos) renders only for
`canViewConsignmentMoney` (manage_consignments or view_costs, D48) and
is absent, not greyed, otherwise; the yield preview only for
`canViewSaleCosts`. Writes need manage_consignments; their buttons are
absent without it.

| Status or balance | Pill tone | Words (`src/lib/consignment.ts`) |
|---|---|---|
| Item active | info | For sale |
| Item sold, outstanding > 0 | waiting | Sold, awaiting payment |
| Item sold, outstanding = 0 | done | Settled |
| Item sold, outstanding < 0 | info | Overpaid |
| Item sold, money hidden | done | Sold |
| Item returned / withdrawn | neutral | Returned / Withdrawn |
| Balance > 0 (`outstandingLabel`) | waiting | $300.00 owed |
| Balance = 0 after something was owed or paid | done | Settled |
| Balance = 0, nothing ever owed or paid (`outstandingLabel` with the owed and paid history) | neutral | Nothing owed yet |
| Balance < 0 | info | Overpaid $40.00 (consignor owes the shop), never "credit" (D46), with one line of remedies |

| Component | Notes |
|---|---|
| `ConsignorSheet`, `NewConsignorButton`, `EditConsignorButton` | Name (required), phone, email, an optional `CustomerPicker` link that prefills empty fields, payout details (never shown back: on edit, empty keeps them), internal notes; `newId()` key; creating opens the consignor. |
| `ConsignorPicker` | `SearchPicker` over active consignors (`searchConsignorsAction`); its action row "New consignor "<typed>"" hands the text to the intake. |
| `ReceiveItemButton` / `ConsignmentIntakeSheet` | Four fieldsets, each `min-w-0` so a segmented control scrolls inside its row instead of widening the sheet past a phone screen: consignor (preset, picker, or a new consignor with an optional customer link, created by the intake RPC in the same transaction with its own id, so a refused intake leaves no consignor); what (One item (bike, frame, wheelset) / Several identical; a shop bike `SearchPicker` for one item (no owner, not in stock; prefills name, brand, serial; D51 hint), name, brand, description, category, serial and condition or a quantity stepper, "Kept at" as segments for up to 4 active locations, else a select); money (amount owed per item, 0 allowed, D24; asking price; a "If it sells at the asking price: yield · Cult Commons · BICII keeps" preview for view_costs); paperwork (received date sent as NULL when left at today, notes). Item, product, unit and consignor ids are made when the sheet opens; every value is state, so a retry sends the same request. Toast "C-000123 received", then the item page. |
| `ConsignmentItemRow` (server) | A RowList row: C- number and status pill on the first line, the name on its own line (never squeezed out on a phone), details, and the amount owed for money users. |
| `EditTermsButton` | Amount owed and asking price; a "Why is the amount owed changing?" field appears (required) once the amount owed differs. |
| `AddChargeButton` / `ChargeSheet`, `VoidChargeControl` | Description, amount (> 0) and "Who pays?" as a `SegmentedControl` with nothing chosen; "Add charge" is disabled until one is (D4), with one explanation line per bearer; Shop pays disabled with the reason for quantity items (D45) and once the unit is on a job or sold. Void is a `ReasonConfirm`. |
| `ReturnToConsignorControl` | The `ReasonConfirm` pattern with a `newId()` return id made when it opens; quantity items add where from (the locations holding this item's own stock, D54) and How many (by default all of this item's stock there, "N here, M left with the shop"); the confirm button names the effect ("Return 1 to consignor"). |
| `RecordPaymentButton` / `SettlementSheet` | Amount paid, paid on (today: NULL; else noon Singapore, `paidAtFromDate`), reference, notes; one row per owed item, oldest sale first, with its `outstandingLabel` and an amount; Auto-fill (`autoAllocate`), "Add another item"; a live "Unallocated $x" / "Over by $x" / "Fully allocated" status (the done tone only once an amount is entered and allocated; before that "Enter the amount paid" in the neutral sunken style); a row above what is owed reveals a required "Why pay more than is owed?" (D47). The commit names the amount ("Record payment of $200.00") and is disabled while `allocationProblems` blocks. |
| `ReverseSettlementControl` | `ReasonConfirm` on a payment; the reversal id is made when it opens. A reversed payment stays listed, struck through, with "Reversed: <reason> · <who> · <date>". |
| `PayoutDetailsReveal` | "Show payout details" (manage_consignments) fetches them on demand and shows them inline with Hide; they are never in the page's data. |

Pages: `/consignment` (`LinkSegments` Consignors / Items as `?view=`; the
items' status filter For sale / Sold / Returned / All as links; a
consignor row reads "N for sale · N awaiting payment" for money users and
"N for sale · N sold" otherwise, never who is owed money),
`/consignment/consignors/[id]` (contact, payout details, Balance card,
items grouped Awaiting payment / For sale / Settled and returned (for
staff without money access: Sold / For sale / Returned), Payments,
Archive) and `/consignment/items/[id]` (C- header with consignor, U-/P-
and B- links; Details with "Sold through" jobs and sales; Money card with
the hint "What we pay the consignor when it sells. It is the cost of the
sale."; Charges; Listing photos on the product; Agreement photos;
Return; History as a "Timeline" list, newest first). Phase 4 pages: a
consigned product or unit hides Adjust stock, Split, Add unit and Write
off and says "Consigned stock changes through sale, restock, a job or
return to the consignor." (D50); a consigned unit's Edit details keeps
its price and cost (they are the consignment's terms) and the unit page
gains a Consignment card; a consigned product lists its consignments; a
job's consigned part links "Consigned · <consignor>" to its item.

#### Sales (Phase 6)

Sale status (`saleStatusLabel` / `saleStatusTone` in `src/lib/sales.ts`;
a refund changes only the status, D49):

| State | Tone | Label |
|---|---|---|
| `recorded` | done | Recorded |
| `partially_refunded` | waiting | Partly refunded |
| `refunded` | danger | Refunded |
| `voided` (reserved, never written) | neutral | Voided |
| A line restocked | info badge | Restocked |

| Component | Notes |
|---|---|
| `RecordSaleButton` / `RecordSaleSheet` | "New sale" on `/sales`, "Sell" on the consignment item, unit and product pages (any staff, D48; a Sell entry point presets its item by searching its short ID). Lines: title, short ID, "3 in stock at Shop floor" (a unit: "At Shop floor"), "Consigned · <consignor>" (a consigned quantity row is one consignment and the line sends its `consignment_item_id`, D45), a money `NumberInput` prefilled with the database selling price (`unit_price`), a quantity stepper capped at what the row holds, Remove. `priceWarnings` under the price: "Below the asking price" for everyone, "Below cost: this sale loses money" for view_costs (D53; never blocks). Add item reveals the picker again; Customer (optional `CustomerPicker`, walk-in otherwise); "Sold earlier?" reveals a shop-time `datetime-local` (max now; NULL while closed or empty); Notes. A view_costs "Preview" (cost, yield, Cult Commons) per line and in total, through `previewSale` (`lineEconomics`). Footer: the Decimal running total and "Record sale · $X". The sale id is made when the sheet opens; errors show as an alert, the lines stay, and a unit sold meanwhile is outlined with "Already sold or taken. Remove this line.". A refusal is shown where it applies: Sold at, Customer and Notes carry their field errors (a time after the moment of submitting is caught in the sheet with "Enter a date and time that is not in the future."; the database's `sale_recognized_in_future` and `sale_before_stock` land on Sold at too), the first marked field takes the focus (`useFocusFirstInvalid`), and a refusal with no field scrolls the alert into view and focuses it. A preset whose search fails (a dropped connection) falls back to the picker with the "no longer available" note instead of "Finding the item…". Success: toast "S-000123 recorded" and the sale page. |
| `SaleablePicker` | `SearchPicker` over `searchSaleableAction` (`saleable_stock`): U-, P- and C- numbers, SKU, serial, name. Each result: title and price, short ID, a `StockBadge` with where and how many, the consignor badge; a unit already on the sale is disabled. |
| `RecordRefundButton` / `RefundSheet` | Admins and managers only (`canRecordRefund`, D94 amending D49), shown while something is left to refund. Amount defaults to `refundableAmount` and is capped at it; the info note "A refund does not put anything back in stock. If the item came back, restock it separately." (D7); the reason through `ReasonConfirm` ("Record refund of $5.00…" then "Refund $5.00"); the refund id is made when the sheet opens. |
| `RestockControl` | `ReasonConfirm` "Restock… U-000123" on a unit line still sold on this sale (`unit_sold_sale_line_id` = the line) and on the unit page's Restock card; for adjust_stock holders, and for a consigned unit only with manage_consignments too (D46). It always sends this line's id; "Back to" location segments (default: where it was sold) while confirming when there is more than one active location; a consigned unit says "It goes back on sale for the consignor and is no longer owed to them." |

Pages: `/sales` (`PageHeader` "Sales" with New sale; range links Today /
7 days (default) / 30 days as `?range=`, Singapore shop days; a
`SearchField` whose query searches every date; rows with the S- number
and time, Partly refunded / Refunded, Restocked and Consigned badges, the
first item "+N more", the customer or "Walk-in", the total and, for
view_costs, "Yield $x · Cult Commons $y"; empty state "No sales in this
period") and `/sales/[id]` (the S- number as the h1, status, date and
time, "In store", the customer link or Walk-in, "Recorded by …", Record
refund; Items: each line linked to its unit, consignment or product,
quantity × price and total, "Consigned by <name> · C-…" and, for
consignment money users, "owed $500.00, paid separately", a bike line's
link and "Ownership is not transferred automatically; use Transfer on the
bike page." (D51), Restocked with when and by whom, per-line cost, yield
and Cult Commons for view_costs, Restock; a "Yield" card for view_costs:
Sale, Direct cost (incl. consignor payout), Yield, Cult Commons (30% of
positive yield), BICII after Cult Commons; Refunds with what is left to
refund; Notes). The unit page shows "Sold on S-…" and a Restock card when
a sale sold it. Today's "Consignment sales" tile links to that shop
day's sales, `/sales?day=YYYY-MM-DD` (today or a past day; the Sales
page's heading names the day and no range is current), and "New
consignor liability" (view_financial_reports and view_costs, D30) to
`/consignment`; both always show an amount now.

### Scanning

- **Scan screen** (`/scan`, `Scanner`): mobile-first; the square
  viewfinder (a yellow-bordered square over a dimmed `<video playsInline
  muted autoPlay>`) fills the width on phones and is capped at `max-w-md`
  on iPad; "Hold the label inside the square."; a Torch on/off toggle when
  `track.getCapabilities().torch`; under it, always, "Or type the code on
  the label" (`autoCapitalize="characters"`, autocomplete off,
  `enterKeyHint="go"`) with Open, which goes to `/q/{code}` when it parses
  (a short ID in any case, or a pasted BICII label URL) and otherwise says
  "Enter a code like P-000123". It works with no camera at all. The page
  pads its bottom like every page, so the raised Scan tab and toasts never
  cover the field.
- **Decoder choice**: `BarcodeDetector` when it exists and
  `getSupportedFormats()` includes `qr_code`, run at most ~6 times a second
  on `requestVideoFrameCallback` (else a throttled `requestAnimationFrame`);
  otherwise `@zxing/browser`'s `BrowserQRCodeReader.decodeFromVideoElement`,
  imported dynamically only then, so ZXing (~470 KB) is never in the first
  load.
- **Camera lifecycle**: `getUserMedia({ video: { facingMode: "environment" } })`
  starts at once when access is already granted, otherwise after "Allow
  camera". Every track stops on unmount, on `visibilitychange` to hidden
  and on `pagehide`, and before navigating away on a hit; the camera
  restarts when the page is visible again. A session counter makes a late
  async step of an old start give up. Errors map onto `CameraPermission`'s
  messages (blocked, unsupported, needs HTTPS, would not start).
- **What a code means** (`interpretScan`, `src/lib/scan.ts`): a BICII label
  is `{base}/q/{shortId}` for an accepted public base (`scanBases()` in
  `src/lib/qr.ts`: today `NEXT_PUBLIC_PUBLIC_SITE_URL`; Phase 8 adds the
  database QR base there and nowhere else), a `/q/{shortId}` URL on the
  Admin's own origin, or a bare short ID. A hit vibrates (30 ms), stops the
  camera and pushes `/q/{shortId}`. Anything else shows "Not a BICII
  label" with the text cut to 60 characters, keeps scanning and ignores the
  same text for 2 s. A foreign code is **never** opened, followed, fetched
  or rendered as a link, whatever its scheme.
- **The /q resolver** (`/q/[shortId]`, the only Admin /q route):
  `requireStaff()`, then `resolveShortId` (`src/lib/domain/scan.ts`: the
  prefix picks the table, RLS-scoped, archived records included) and
  `redirect()` to the page from `hrefForRecord` (`src/lib/ids.ts`, also used
  by search hits). An unknown code renders the not-found content in the
  shell: "No record with P-999999", Scan again and Search. It has no
  `loading.tsx`: a loading boundary would commit a 200 before the redirect
  (see "Loading"). Later phases extend `resolveShortId` (C- and S- in Phase
  6, PO- in Phase 7) instead of adding routes.
- **Header short-ID jump**: see `HeaderSearch`; the same /q route answers
  it, so a typed B-/J-/P-/U- number and a scanned label land the same way.

### Workshop

- **Cost visibility.** Cost, yield and Cult Commons figures exist in a
  job's data only for staff with `view_costs`: the domain reads lines from
  the base table's cost-free columns (or `work_order_line_items_staff`)
  and totals from `work_order_totals` (or `work_order_totals_staff`), so
  a DTO for anyone else has no `costs` key to hide. Screens never filter
  numbers out of a fuller object; entering a cost (a service override or a
  manual line's cost) is offered only with `view_costs` and refused by the
  action and the RPC otherwise (D14). The timeline carries no costs for
  anyone.
- **Intake photos follow creation.** `record_attachment` needs the job row
  to exist, so the wizard creates the job first and lands on
  `/jobs/{id}?intake=photos`: the "Intake photos" card comes first there,
  with the camera prominent, the upload tiles and "Done" (which drops
  `?intake`). The upload queue lives above the pages, so leaving early
  loses nothing.
- **The board** (`/jobs`, SPEC §7.2): a list of rows by group rather than
  columns, so it works one-handed on a phone (Kanban is optional). Order:
  title with "New job" (on phones a full-width button at the top instead),
  the view switch, the job number box (`SearchField`, exact number however
  typed) and Filters, the active filter chips, the group chips with counts,
  then one section per non-empty group, oldest check-in first (the
  longest-waiting bike on top). "All open" shows every group but Closed;
  a group chip shows that group alone; Closed lists jobs collected or
  cancelled in the last 30 days (any time when a job number is typed),
  newest first, 50 at a time with "Show more". Counts follow every filter
  but the group. The board reads at most the newest 300 open jobs; past
  that it shows the usual truncation notice and says "Counts cover the
  newest 300 open jobs." Empty states differ per view ("No jobs assigned
  to you — pick one from Unassigned", with a link there).
- **Services settings** (`/settings/services`, every staff member): the
  services by category with price and Inactive / Not public badges, the
  cost only with view_costs, Active / Archived (`ArchivedFilter`), and the
  note "Changing a price or cost affects new job lines only; existing lines
  keep their snapshot." The Cult Commons card (view_costs only) shows the
  rate in force large, scheduled rates (admins: Cancel) and earlier ones
  with who set them and when, cancelled ones marked "Cancelled". It has a
  `loading.tsx` (no permission gate below it).
- **Job page order** (phone): header (J- number, status, overdue badge,
  bike, customer with tap-to-call, check-in date and age), status actions,
  intake photos (intake only), requested work and condition, lines with
  totals, the indent parts and quote card (not on a closed job where nothing
  was ever proposed), the Customer payments card (when `showsPaymentsCard`
  holds: a deposit, a Stripe or counter payment, Send payment link applies,
  or an admin on a job that is not cancelled; hidden if its read fails),
  photos; then people (`AssignmentsCard`), dates (each stamp its
  own row: completed and collected never merge), notes (always shown:
  `ApprovalSwitch`, internal and completion notes, Add note / Add
  diagnosis) and the timeline, a second column on wide screens. "Edit" on
  Requested work opens the details sheet.

### Today

`/` (SPEC §19.1; PLAN D30–D35), components in `src/components/domain/today/`
(server unless noted), reads in `src/lib/domain/reports.ts` over the Phase
5 read RPCs, shapes and wording in `src/lib/reports.ts`.

- **The database decides which day is today** (D35). The page asks
  `today_dashboard` for the `?day=` given (a real `YYYY-MM-DD` before this
  server's shop day), else for null; if the database refuses an explicit
  day as in its future (clocks either side of Singapore midnight) it asks
  again with null, so a day choice never errors. Every other read, label,
  the Next-day link (disabled on today) and the date input's `max` use the
  `day` and `is_today` the database returned. A garbage `?day=` is today,
  and so is one before `EARLIEST_SHOP_DAY` (2000-01-01, the date input's
  `min`; Previous day is disabled on it). `parseShopDay` reads years
  0001-9999 as themselves and `shiftShopDay` only returns days that parse
  back, so no derived day (the week strip's) can throw while rendering.
- **Flows vs snapshot** (D31). "Today" / "On Sat, 3 Oct": Checked in,
  Started, Completed, Ready for collection, Collected (Cancelled when > 0),
  the jobs whose current stamp falls on the day; each links to its list in
  Activity. "Right now" (today only): Received, Waiting, Ready to start,
  In progress, Awaiting collection ("Completed, not yet collected": the
  Completed and Ready for collection statuses together, D31, so it never
  shares a name with the flow tile, the status or the board's Ready for
  collection column) and Overdue ("Open more than 7 days",
  `OVERDUE_AFTER_DAYS`), the current snapshot grouped as `BOARD_GROUPS`,
  each linking to the board filtered the same way (`TILE_LINKS`). A past
  day has no snapshot, no low stock and no "Needs attention".
- **Permissions** (D30). Money needs View financial reports: without it
  the section is not rendered at all. Inside it, COGS, Yield, Cult Commons
  and BICII after Cult Commons need View costs too; without it one line
  says "Costs, yield and Cult Commons need the View costs permission." The
  database returns hidden figures as NULL and the DTO keeps them null; the
  UI never derives one. Workshop, stock and exception counts are for all
  active staff; an adjustment's value at cost only with View costs.
- **Money notes.** Danger: the loss note (D1). Warning: "Provisional: N
  lines have no cost entered…" (D14). On a past day, muted: "Counts jobs
  completed and sales recorded on this day. If a job is reopened, it moves
  to the day it is completed again." (D32; words, not colour).
- **Appointments** (Phase 2, D30, D41). `AppointmentsSection`: Scheduled
  ("Booked for this day"), Arrived ("Including checked in") and No-shows
  from `today_dashboard`, by scheduled day and current status, for every
  staff member; the placeholder treatment only for a row the database did
  not count. On today its `children` is `TodayArrivals` (streamed):
  "Still expected" (booked or confirmed, linking to the day view) and
  "Arrivals", the first five expected, late ones first, each a row (time,
  customer, type, solid "Late") opening `/appointments/<id>` with the name
  "10:30, Hafiz Rahman, Service drop-off, late"; "See all" opens
  `/appointments?date=<day>`; "N more expected later"; empty: "No more
  arrivals expected today" with Book. A past day shows only the counts.
- **Consignment tiles (Phase 6).** "Consignment sales" (the day's sales
  and completed jobs with a consigned line, count and total; the hint says
  "N sales or jobs with consigned items"; links to that day's Sales list,
  `/sales?day=`, where the sales are; the jobs are under Jobs completed) and,
  for view_costs, "New consignor liability" (what the day's consigned
  lines owe their consignors; links to Consignment) always show an amount.
  Money also counts in-store sales: Gross sales is jobs completed and
  sales recorded on the day.
- **Needs attention links to the full list (Phase 9).** Beside the
  section's count, "See all" (named "See all exceptions" for screen
  readers, the low-stock "See all" pattern) opens `/reports/exceptions`,
  and the capped-list note ("Showing the 20 most urgent of 45") is a link
  there too. Nothing else on Today changed: the same `ExceptionList`, the
  same 20 rows, no second tile. The Activity and Stock grids are
  `grid-cols-1` on phones (with `min-w-0` items), so a long customer or
  bike name truncates instead of widening the page (found in Phase 9 step
  4's E2E run).
- **Streaming.** The dashboard row loads first; each list (financial
  entries, adjustments, low stock, exceptions, activity, last 7 days) is a
  `SectionLoader` (async) in its own `<Suspense>` with a `SectionSkeleton`,
  and a failed read logs and shows "Couldn't load this. Refresh the page to
  try again." in place. Still no `loading.tsx` at the group root (see
  "Loading").
- **Layout.** Phone: one column, two-column tile grids, 44 px targets;
  from md three or four columns and the lists side by side. Numbers are
  `font-display tabular-nums`. Every tile is a `<dl>`/`<dt>`/`<dd>`; a
  linked tile's name is "Completed: 3"; money tiles show the currency
  code; section headings are `<h2>`. A money amount never leaves its card:
  the tile's `<dl>` is a size container, the amount's size is a share of
  its width picked by the amount's length (`moneySizeClass`, capped at the
  usual size, floored at 1rem) and the currency code wraps under it when
  both do not fit, so "$400.00" stays large in a half-width phone tile and
  "$12,345.67" shrinks beside the iPad side rail.

| Component | Notes |
|---|---|
| `StatTile`, `MoneyTile`, `TileGrid`, `TodaySection` (`stat-tile.tsx`) | A figure as `<dl>` with label, value, hint, optional link, tone (value colour only) and `notTracked` ("—" and `NOT_TRACKED`, "Not tracked yet", for screen readers: the one source of that wording); money formatted with a real minus sign and its currency, scaled to the tile (see Layout); the grid; a section with its `<h2>`. |
| `AppointmentsSection`, `TodayArrivals` (`appointments-section.tsx`) | The appointment tiles and the expected arrivals, above. |
| `DayNavigator` (client) | ‹ Previous day / Today / Next day › links and a `next/form` GET form (`<input type="date" name="day">` with `min` and `max`, "Go"); works before hydration; once hydrated a picked date submits after a 600 ms pause (typing a year passes through "0002"). |
| `RefreshButton` (client) | "Updated 10:42 am" and Refresh: `router.refresh()` in a transition with a spinner; returning to the tab refreshes once the figures are a minute old. |
| `ActivityList` | One flow's jobs from `work_order_activity_on`: J- number, status pill, Overdue badge, customer, bike, sale total; the heading's id is the flow tile's anchor. Checked in, Completed and Collected always; Started, Ready for collection and Cancelled when not empty; "Nothing happened on this day" for a quiet day. |
| `AdjustmentList` | The day's adjustments and damaged stock: signed delta, P- link, reason, type · location · actor · time, a "Significant" badge (D33) and the value at cost when present. Significant ones first, then newest first; the first `ADJUSTMENT_ROWS` (5) listed and the rest behind a `<details>` "Show N more" (no JavaScript), so an opening stock count does not push "Needs attention" screens down. |
| `LowStockList` | The first 5 of P4's `reporting.low_stock` (largest shortfall first) with `StockBadge`; "See all" opens `/inventory?filter=low`. |
| `ExceptionList` | D34 exceptions, danger first: pill (tone and words; Overdue is danger, as on the Overdue tile and the board's badge, while Not collected and other warnings are waiting), short ID, subject (one truncated line, except `payment_attention` and `stripe_attention`, Phase 14, whose subject is the actionable sentence and wraps in full, `exceptionSubjectIsSentence`, on Today and `/reports/exceptions`), `exceptionCopy` sentence; rows link through `exceptionHref` (a line opens its job via `/q/J-…`; an `integration_failed` row, admins only (D86), shows "Shopify needs attention", the order or product, the human message as its subject line and "Fix it in the Shopify queue", and opens `/shopify/queue?job=<id>` with that job's sheet open); unknown kinds render a generic sentence; keyed by `exceptionKeys` (a product below zero at two locations is two rows); Today lists the 20 most urgent and, when there are more, says "Showing the 20 most urgent of 45" under them (Phase 9 makes it a link to `/reports/exceptions`); EmptyState "Nothing needs attention".; rows link through `exceptionHref` (a line opens its job via `/q/J-…`); unknown kinds render a generic sentence; keyed by `exceptionKeys` (a product below zero at two locations is two rows); Today lists the 20 most urgent and, when there are more, says "Showing the 20 most urgent of 45" under them (with `moreHref`, a link to `/reports/exceptions`); EmptyState "Nothing needs attention". Phase 9 adds optional props only (`detailed`, `action`, `label`, `empty`, `moreHref`): without them a row renders exactly as before (a unit test compares the markup). |
| `FinancialEntries` | `<details id="financial-entries">` "What makes up these figures" (open with `?entries=open`): the day's `financial_lines` grouped by job (J- link), description, quantity, sale, and yield and Cult Commons when visible; "Sold at a loss" and "Cost pending" badges. It adds nothing up. |
| `WeekStrip` | "Last 7 days" ending at the day shown: completed, collected, and gross sales, yield and Cult Commons when visible; each day links to `/?day=`; the day shown has `aria-current="date"` and a bold row. A table from md, stacked cards on a phone; on an iPad an admin's six columns (~600px) are wider than the column (~520px), so the table scrolls inside its card, never the page. |
| `SectionLoader`, `SectionSkeleton`, `SectionError` (`section-loader.tsx`) | The streaming pattern above. |

### Appointments

`/appointments`, `/appointments/[id]` and `/appointments/[id]/check-in`
(SPEC §6; PLAN D2, D36–D42), with Today's tiles and arrivals, the
customer page's section, the job's link back and the schedule settings. Reads in
`src/lib/domain/appointments.ts`; the grid, statuses, history wording and
times in `src/lib/appointments/` (pure: `slots.ts` mirrors the database's
slot functions exactly, `status.ts`, `history.ts`, `time.ts`,
`format.ts`, 24-hour "10:00–10:30" in shop time).

- **The list** is a URL: `?date=` (shop-local today when missing or not a
  real day) and `?view=day|week`; Day/Week links styled like
  `SegmentedControl` (`LinkSegments`), Today, ‹ › by a day or a week. The
  Monday–Sunday strip sticks under the header: 64px day links with the
  weekday, date, the count of appointments that are not cancelled (D41)
  and "Closed" / "Short day" ("Short" on phones), `aria-current="date"` on
  the day shown and the whole day in its accessible name.
- **The day view** groups rows by start time; each row links to
  `/appointments/<id>` (the href is the E2E locator) and shows the time
  range, `StatusPill`, "Booked online", a solid "Late" (15 minutes past a
  booked or confirmed start), a "Note" badge, and a solid waiting badge
  "Outside opening hours" / "Shop closed" for an active booking a
  settings change left behind (D38: settings never move bookings, so
  screens flag them; closure first, the grid is not a reason to warn).
  Cancelled ones fold under "N cancelled". A closed day is an EmptyState
  "Closed: <reason>" with the next open day, still listing its bookings;
  custom hours are a banner "Short day 12:00–16:00: <reason>" ("Different
  hours" when not shorter). Capacity is one slim bar per slot with its
  words ("1 of 2 booked"; red and "3 of 2 booked" when over), beside the
  list from lg. The week view is an agenda whose columns follow its own
  width (a container query, so the side rail counts): stacked on phones,
  two to four columns on tablets, seven only from 72rem; each row has the
  time, `StatusPill` and the day view's badges, which wrap inside a narrow
  column rather than run into the next day.
- **Booking** (`BookAppointmentSheet`, props `open`, `onOpenChange`,
  `presetCustomer`, `lockCustomer`, `presetDate` (a past date falls back
  to today); `BookAppointmentButton` with the same presets, `label`,
  `buttonVariant`, `size`, `disabled` and `variant` "button" (md+) or "fab", the phones' yellow Book above the tab bar,
  right of Scan): customer (`CustomerPicker`, or a fixed name when locked;
  "New customer…" links to Customers rather than nesting a sheet), type
  as radio cards (staff-only types badged), date as a 14-day chip strip
  plus a native date input, times as a 3–4 column grid of 44px radios
  with "N left", bike ("Decide at check-in" first), the two notes. One
  `loadSchedule` per 14-day window; every day's times are computed in the
  browser, so changing type or day is instant and "Next day with free
  times" needs no request. Radios are native inputs inside their cards
  (`sr-only` inside a `relative` label), so arrows move within a group and
  the focus ring is drawn on the card (`has-[:focus-visible]`). The form
  submits through `onSubmit` with controlled state (nothing typed is ever
  reset); a slot refusal is the Time field's error (focus and scroll go
  there, an error toast says it too), reloads the times and keeps the
  rest. The free times are computed against the server's clock
  (`ScheduleData.asOf` plus the time since the load), not the device's.
- **The detail page** wraps its content in `AppointmentStatusScope`
  (`useOptimistic` status shared by `AppointmentStatusPill` in the header
  and `AppointmentActionBar`), so Arrived changes the pill at once. The
  bar sticks above the tab bar on phones and sits under the header from
  md: the next step first (Arrived, Check in, or Reinstate as arrived on
  the no-show's own day), then Check in, Confirm, "No-show…" (confirm
  without a reason: focus on Cancel, "Mark no-show" disabled 400 ms) and
  "Cancel appointment…" (`ReasonConfirm`, "Keep appointment"); every
  button rests 400 ms after a status change (`useArmedAfter`). Cards:
  Job (once checked in), Customer (tap to call), Bike (Change before
  check-in), Notes (Edit sends only changed fields), Details, History
  (plain sentences with actor and time).
- **Check-in** (`CheckInForm`): bike cards (the appointment's
  preselected) with "Add a bike" opening `BikeSheet` with the owner
  preset and its `onCreated`; New job / Existing job J-… when that bike
  has open jobs without an appointment; requested work prefilled from the
  customer's note, condition on arrival and `LeadPicker` (the intake's
  lead chips, extracted to `lead-picker.tsx`: "Me" first, Unassigned
  last); one sticky "Check in and open job". A refusal no field explains
  also shows as an error toast beside that button. A new job opens on its
  intake photos step (`/jobs/<id>?intake=photos`).
- **Status → tone** (`appointmentTone`, `StatusPill` with its words):
  Booked info, Confirmed progress, Arrived waiting, Checked in and
  Completed done, No-show danger, Cancelled neutral (struck through in the
  week agenda and the customer page). Completed is never a button (D36:
  the job completes it). Two-step rules: No-show confirms without a reason
  (focus on Cancel, the confirm rests 400 ms); Cancel is `ReasonConfirm`
  (required reason, "Keep appointment"); cancelled and completed are final
  (D39).
- **Source badge**: "Booked online" (info) on customer bookings in every
  list; the customer page shows "Booked by staff" (neutral) too.
- **Schedule warning badges** (D38): solid waiting "Outside opening hours"
  / "Shop closed" on a row, and "N appointments affected" on a closure in
  settings, linking to the first affected day.
- **Customer page**: an Appointments card (upcoming from today, soonest
  first, then "Past" with the latest five; `CustomerAppointmentRows`: day
  and time range, `StatusPill`, source badge, type, bike and job) with
  "Book appointment" (`BookAppointmentButton` with `presetCustomer`,
  `lockCustomer`, `buttonVariant="outline"`, `size="sm"`, `disabled` for
  an archived customer, like Add bike).
- **Job page**: a "Booked appointment · Tue 6 Oct 10:00 · Service
  drop-off" chip under the header when the job came from an appointment;
  the timeline's `appointment_linked` line reads "Opened from the
  appointment on …" (check-in created the job) or "Linked to the
  appointment on …", and its title is a link (`EventDescription.href`).
- **Schedule settings** (`schedule-settings.tsx`, client sheets; admin
  only, each submits through `onSubmit` with controlled state and stays
  open on a refusal): Booking capacity (`NumberInput`s: slot length,
  bikes per slot, minimum notice, how far ahead, online bookings per
  customer, online cancellation cutoff; read-only it shows the D2 sentence
  "Up to 2 bikes can be booked in for each 30-minute slot.", "Customers
  can cancel online until 2 hours before." and "Singapore time");
  `WeeklyHoursList` (Monday first, "10:00–19:00" / "09:00–12:30,
  13:30–18:00" / "Closed"; for admins each row is a button opening the
  day's sheet: "Open on <weekday>" `Switch`, up to four interval rows of
  time inputs with add and remove, 00:00 as a closing time meaning
  midnight, overlap and order errors listed on the group); closures (an
  "Add closure" / Edit sheet: `SegmentedControl` Closed / Short day, first
  and last day, "Only part of the day" for Closed (forces one day), opens
  and closes for a short day, reason; "Delete…" with `ReasonConfirm`,
  named for its closure ("Delete the Tue 13 Oct closure…"); past
  ones under a collapsed "Past"). Every save toasts the upcoming bookings
  the schedule no longer fits, with "Show" opening the first such day.
  Closures and types carry a `newId()` from the sheet (Add sends `isNew`).
- **Appointment types** (`/settings/appointment-types`,
  `AppointmentTypeSheet`): rows with name, duration, units, Public / Staff
  only, Inactive (inactive last) and sort order; the admin sheet has name,
  description, duration, capacity units (at most the shop's), "Public"
  ("Customers can book this on the BICII website"), Active and sort order.
  Types are never deleted, and the page says so.

### The customer's quote page

`/quote/<token>` (Phase 13 step 3, D142, D143) is one of the Admin's two
pages for customers (the other is the payment page, below): the
`(customer)` route group's layout is the logo on paper in
a single column (max-width xl, the page gutter), no shell, no links into
the Admin. Order: eyebrow "Job J-… · <bike>", the heading "Hi <first
name>, here is your quote", one line on what to do and until when the
link works, then the **Items** card: each item a list row (description,
"Part" or "Labour" · quantity × price, the line total) with an
Approve / Decline `SegmentedControl` that starts with nothing chosen,
then "Quote total" and "You approve" (an `<output>` that follows the
choices). **Your name** (autocomplete `name`) and one large **Send my
answer**. Sending with an item unanswered names the items ("Approve or
decline every item: Brake pads and Chain still need an answer.", three
names then "and N more"), marks their groups `aria-invalid` with a danger
outline (every group is `aria-required`) and focuses the first; a missing
name focuses the name field; a dropped connection says "We couldn't reach
the shop. Check your connection and try again." (audit U2-1, U2-3, U2-2);
database refusals come back as one alert in the customer's words
(expired, already answered, the job closed). Once answered, the page is
the thank-you status ("Thank you, <name>. You approved 2 of 3 items on
…"), which takes focus in the tab that just sent the answer (U2-4), over
a read-only **Your answer** list and the approved total. The expiry reads
"(Singapore time)". Under every customer page: "Questions? Message the
shop on Instagram" (U2-14), and `(customer)/error.tsx` is the customers'
own error page ("This page couldn't be shown", Try again, the shop
link, the digest as "Reference for the shop"; nothing about the Admin). A
withdrawn, expired or malformed link is a heading and one sentence saying
what to do (ask the shop for a new link). No costs, no supplier,
no contact details, no staff names (D143).

**The deposit** (Phase 14 step 2; D151, D153, D158; ADR-025). The page
reads `quote_by_token`'s `deposit` key (optional, so an older payload
parses as none) and never computes an amount. While open, one more
sentence after the intro: "After you answer, the shop asks for a deposit
of N% of the parts you approve (not labour), paid online by card or
PayNow. Your approval stands either way; …" (the payment clause only
while Stripe is on). Once answered with a deposit, the thank-you status
ends "The shop orders your parts once the deposit is paid." (due or being
confirmed) or "Your deposit is paid, so the shop will order your parts."
(`answeredNext`); once the shop has ordered the parts without waiting
(`parts_ordered`, D152) it ends "The shop has ordered your parts. Ask the
shop if you still need to pay the deposit." (due), "The shop has ordered
your parts." (being confirmed) or "Your deposit is paid and the shop has
ordered your parts."; once the job is completed, ready, collected or
cancelled without the parts ordered or fitted (`job_closed`, R-082) and
the deposit not refunded, it ends "Ask the shop about your deposit."
instead,
and a **Deposit** card follows it (`deposit-card.tsx`, server): the amount
in large type, "N% of the parts you approved", then by state:

| State | The card shows |
|---|---|
| due, Stripe on | **Pay $… deposit** (`PayDepositButton`: full width, large, pending "Opening Stripe…", stays busy while the browser leaves and resets when Back restores the page from the back-forward cache; an error is one `role="alert"` line), then "Pay securely by card or PayNow with Stripe. You'll come back to this page. Pressing again never charges you twice." and the privacy line (`StripePrivacyLine`, shared with the payment page): "Payments are taken by Stripe on its own page, so Stripe's privacy policy applies to them; BICII never sees or keeps your card details." With the parts already ordered, first "The shop has already ordered your parts. If you paid the deposit another way, ask the shop before paying here." |
| due, Stripe off | "The shop will tell you how to pay the deposit." |
| due, back from Stripe (`?deposit=returned`) | `ConfirmingPayment`: `role="status"` "Thanks. We're confirming your payment with Stripe…"; one check at Stripe, then a refresh every 5 s, at most 12; then "Stripe hasn't confirmed your payment yet. If you paid, you don't need to pay again; it shows here soon." with "If you didn't finish, you can pay below." and the Pay button again (the same session) with the privacy line under it while Stripe is on, or "The shop will tell you how to pay the deposit." while it is off. `?deposit=returned` leaves the address (`history.replaceState`, no navigation) once the check settles it or the minute is up, so a restored tab shows the deposit as it is |
| due, Checkout left (`?deposit=cancelled`) | `role="status"` "Payment not finished. Nothing was charged. You can pay the deposit below whenever you're ready.", then the button |
| processing | "Your payment of $… is being confirmed by Stripe. Reload this page later to see it confirmed. You don't need to pay again." (the page does not poll in this state) |
| paid | a done-tone **Paid** badge and "Deposit of $… paid. Thank you."; refunded in part in Stripe (the payload's `refunded` above 0, U2-11), "Deposit of $… paid. $… of your deposit was refunded." instead |
| refunded | "Your deposit of $… was refunded. Ask the shop if you have questions." |

The page now links out once: Pay sends the browser to Stripe's hosted
Checkout (`checkout.stripe.com`, checked before redirecting), which
returns to the same page. The return's query string only picks the words;
what is paid is Stripe's data. The page keeps no-referrer, noindex and
`private, no-store`.

### The customer's payment page

`/pay/<token>` (Phase 14 step 3; D156, D156f; ADR-025;
`src/app/(customer)/pay/[token]/`) is the bill a payment link opens,
signed out, in the same `(customer)` layout. It is read as anon through
`balance_by_token` and parsed by `src/lib/balance-page.ts` (zod; the two
key sets are pinned, so an unknown key is dropped, never shown); it never
computes an amount. The order of the checks: the 43-character token shape
(a malformed one is "This link is not valid" with no count and no read),
then the per-client and per-token **view** limit (`balance-view`, 60 per
5 minutes; "Too many requests" when over), then the read ("This bill
can't be shown right now" on an error). Title "Your bill · BICII",
`robots` noindex, nofollow, nocache and `referrer` no-referrer in the
metadata; `next.config.ts` sends Referrer-Policy `no-referrer`,
X-Robots-Tag `noindex, nofollow` and Cache-Control `private, no-store` on
`/pay/:token*` too (the same constant as `/quote/`), so the return URL
`?balance=returned` gets them as well.

| What the link reads | The page shows |
|---|---|
| unknown or malformed token | "This link is not valid" and "Check you opened the whole link, or ask the shop for a new one." |
| withdrawn (a resend, a reopen or Collected) | "Your bill for job J-…" and "This payment link was replaced or stopped. Ask the shop for a new one." |
| expired | "Your bill for job J-…" and "This payment link has expired. Ask the shop for a new one." |
| closed (a fallback: the job is no longer completed or ready) | "Your bill for job J-…" and "This job has changed. Ask the shop how to pay." |
| open | eyebrow "Job J-… · <bike>" (brand, model, variant; never a serial), "Hi <first name>, here is your bill", a **Your bill** card listing each live line (description with any unit number and serial cut by the database, "Quantity N", the line total; "No lines on this bill." when empty), then Job total, Paid so far (online and at the counter, net of Stripe refunds; once anything was refunded the label reads "Paid so far (after $20.00 refunded)", `paidLabel`, U2-11) and **Balance due**; then the **Payment** section below |

The Payment section of an open bill, by `payment`:

| payment | Shows |
|---|---|
| due, Stripe on | **Pay $X** (`PayBalanceButton`, a copy of `PayDepositButton`: busy while the browser leaves, reset when Back restores the page), "Pay securely by card or PayNow with Stripe. You'll come back to this page.", then the privacy line. Pay counts the **pay** limit (`balance-pay`, 10 per 5 minutes). A refusal that is the page's own state (the link stopped or expired, the job closed, the bill too large) refreshes the page, which then says it in its words; any other refusal is one `role="alert"` line |
| due, Stripe off | "The shop will tell you how to pay the balance." |
| due, Checkout left (`?balance=cancelled`) | `role="status"` "Payment not finished. Nothing was charged. You can pay the balance below whenever you're ready.", then Pay |
| processing | "Your payment is being confirmed by Stripe. Reload this page later to see it confirmed. You don't need to pay again." |
| too_small | "Less than $0.50 is left; pay it at the shop." |
| nothing_due | "Nothing is left to pay. Thank you.", and "You have paid more than the bill; the shop will sort out the difference." when `paid_ahead` is above 0 |
| too_large | "This bill is too large to pay online; pay it at the shop." |

Back from Stripe (`?balance=returned`) on a bill that is still due:
`BalanceReturn` (client, around every read of the page) makes one check
at Stripe (`checkBalanceAction`, which never creates or expires a
session), then refreshes every 5 s, at most 12 times, while the page
still says due; `ReturnSlot` (the Pay section's place, read through
context) shows "Thanks. We're confirming your payment with Stripe…"
meanwhile, Stripe's answer ("Thank you. Stripe has confirmed your
payment." or "Thank you. Your payment is being confirmed by Stripe. You
don't need to pay again."), or after the minute "Stripe hasn't confirmed
your payment yet. If you paid, you don't need to pay again; it shows here
soon." (plus "If you didn't finish, you can pay below." and Pay while
Stripe is on). What the check found stays on screen even if the page then
reads as a stopped link (the bike collected meanwhile, step3-critique
C11). When Stripe confirmed a payment but the bill read again after the
check is still due (the payment was for less than is due now, for example
after a counter payment was voided), the slot shows "Thank you. Stripe has
confirmed your payment. $X is still due on this bill." above Pay at the
live amount (`paid_still_due`); `BalanceReturn` tells that read from the
one on arrival by the bill's `balance_due` (compared, never computed),
and until the refresh lands it shows the line only, so a just-paid "Pay
$X" never flashes. When the check found nothing but the bill was read
again at another amount (the webhook recorded the payment first), the
page speaks for itself without a payment claim. `history.replaceState`
drops the marker once the check settles it, the page moves on, or the
minute is up. A return that arrives after the link has stopped (Collected,
reopen, or a resend) shows the notice and makes no check
([R-092](RISKS.md#r-092--open-checkout-tabs-can-still-be-paid-for-up-to-60-minutes)). No costs, staff names, contacts,
unit numbers, serials, Stripe ids or other jobs, ever (D156f).

### Photos and images

- Photos are shown with `next/image` **unoptimized** (a plain lazy `<img>`
  with width and height), not through the image optimizer, so there is no
  `images.remotePatterns` entry for Storage: internal photos are
  short-lived signed URLs (5 minutes, minted on every render, one
  `createSignedUrls` call per record), which the optimizer would fetch and
  cache on the server under URLs that change every render, keeping private
  photos in a server cache; and the devstack's Storage is on a loopback
  address the optimizer refuses without `dangerouslyAllowLocalIP`. Public
  photos use their public URL. Thumbnails are therefore the uploaded
  photos (at most 2048 px, typically 200–600 KB), loaded lazily.
- A signed URL that has expired by the time it loads (a page left open)
  triggers one `router.refresh()` (at most once a minute) to mint new ones.
- Who sees what: **Internal**, staff only; **Customer**, staff and the
  bike's current owner (or the customer, for a customer-record photo) on
  the BICII website once customer accounts launch (Phase 11); both live in
  the private `media-internal` bucket. A job photo's Customer level means
  the job's customer. **Public**, anyone with the link (`media-public`);
  never for a customer record (D13) or a job (D19): the app refuses before
  copying anything to `media-public`, and the database refuses too. Changing to or from
  Public moves the object between buckets (`src/lib/domain/attachments.ts`
  explains the order of steps and what a failure leaves); whatever a failed
  cleanup leaves is removed the next time the record is shown.

### Search

- Lists are search-first: an empty query shows recently updated records,
  a query shows `staff_search` hits (exact B- numbers and serial numbers
  first; serials ignore case, spaces and dashes).
- `/search` groups hits by kind (Customers, Bikes, Jobs, Products,
  Units), the group with the best hit first: an exact J- number
  ("j-000004", "J000004") puts Jobs first, an exact P- number or SKU puts
  Products first. The search fields are labelled "Search customers, bikes,
  jobs and stock". Product hits show the RPC's subtitle ("SKU · brand · 34
  in stock"), unit hits their status first ("Available · Shop floor ·
  S/N …"). An exact short ID typed in the header skips the results and
  opens the record (`/q`). Archived search returns no jobs.
  Recent searches are kept per device in `localStorage`
  (`src/lib/recent-searches.ts`: every access in try/catch, at most eight,
  newest first) when a query is submitted or a result opened, and shown
  before anything is typed. They never reach the server.

### Purchasing

Phase 7 (SPEC §14, §21; PLAN D60–D66). Screens under `/purchasing`,
components in `src/components/domain/purchasing/`, reads in
`src/lib/domain/purchasing.ts` and `src/lib/domain/suppliers.ts`, labels,
tones and sentences in `src/lib/purchasing.ts`, form schemas in
`src/lib/purchasing-forms.ts`.

- **Route group and the 403 rule.** The browsing screens live in the route
  group `src/app/(staff)/purchasing/(browse)/` (no URL segment): `/purchasing`
  (orders), `/purchasing/orders/[id]`, `/purchasing/suppliers` and
  `/purchasing/suppliers/[id]`. The group's `layout.tsx` adds
  `PurchasingNav` (the layout is not async: the staff read deciding whether
  Reorder shows sits under `<Suspense>`, so the nav and skeleton stream at
  once; every page calls `requireStaff()` itself), its `loading.tsx` the
  list skeleton, and each record
  route has its own `loading.tsx`. There is no `loading.tsx` at
  `/purchasing` itself: a loading boundary there would sit above the
  manage_purchasing pages beside the group (receiving and reorder, step 4)
  and turn their `forbidden()` into a 200 (see "Loading"). Those pages go
  outside `(browse)`. Unknown or malformed ids render not-found.
- **Cost gating (D60).** Purchase costs (line unit costs and totals,
  receipt costs, PO totals, supplier last costs, cost defaults, PO history)
  are for `view_costs` or `manage_purchasing` (`canSeePurchaseCosts`,
  mirroring `private.can_view_purchase_costs`). The domain reads them only
  from the `*_staff` views and only for those staff; the DTO otherwise has
  no `costs`, `totals` or `history` key. Every write needs
  manage_purchasing; controls a staff member cannot use are not rendered.
  Totals are `purchase_order_totals_staff`'s, never summed in TypeScript.
- **Closed orders (D61, D65).** Received and cancelled orders have no
  editing. A received order shows "Fully received … Extra or late units go
  on a new order." and, for manage_purchasing, "New order for <supplier>"
  (the preset sheet; full width and wrapping on a phone, so a long name
  never widens the page). Cancelling is final and keeps what arrived.
- **Product page.** Shop-owned counted products get a "Suppliers & orders"
  card (consigned products show their Consignments card instead, D62)
  (`ProductPurchasingCard`): supplier links (each with "Last cost $x ·
  date" for `view_costs` holders only: the product page is not a
  purchasing screen, so `manage_purchasing` alone shows no cost here,
  D60), "On order: N"
  (`reporting.product_on_order`: submitted and partially received only),
  the open orders holding the product, and Add supplier for
  manage_purchasing.

| Component | Notes |
|---|---|
| `PurchasingNav` (`purchasing-nav.tsx`) | Orders · Suppliers as links in a scrolling pill row, `aria-current` on the active one (Orders also on `/purchasing/orders/*`), 44px targets, inset focus ring. Step 4 adds Reorder with its page. |
| `PurchaseOrderStatusPill` (server) | Draft (info), Submitted (waiting), Partially received (progress), Received (done), Cancelled (danger); always with its text. |
| `QuantityProgress` (server) | `role="progressbar"` with `aria-valuenow` = received, `aria-valuemax` = ordered and `aria-valuetext`, plus the same words visibly: "18 of 20 received · 2 to come", "20 of 20 received", "18 of 20 received · 2 cancelled" (`progressText`). A cancelled remainder is hatched, never "to come". A draft (its `status`) reads "15 items · not submitted": nothing is to come until it is sent, as `product_on_order` leaves drafts out (D66); the order list and a supplier's orders use the same words. |
| `PurchaseOrderSheet`, `NewPurchaseOrderButton`, `EditPurchaseOrderButton` | New order or Edit details; body mounted only while open. New: `newId()` made on open is the order's id and idempotency key; the supplier is picked (`SupplierPicker`) or PRESET with the `supplier` prop (a supplier's page, a received order's "New order for …", step 4's closed receive page), expected date (native date input), supplier reference, notes; Create opens the draft. Edit: the supplier is fixed once submitted, with why. The server sets the currency. |
| `PurchaseOrderLines` | The order's lines: one DOM with explicit table roles ("Order lines"), stacked rows on a phone and an upright iPad, a dense table (`text-dense`, `tabular-nums`) once its card is 42rem wide (a container query, as `LineTable`: the card, not the screen). Product (P- link, SKU, on hand), `QuantityProgress`, expected date or a solid danger "Overdue" badge, and only for cost-visible staff unit cost and line total. On an open order a manage_purchasing row is a button ("Change line: …") opening the line sheet. |
| `PurchaseOrderLineSheet`, `AddPurchaseOrderLineButton` | Add: `PurchaseProductPicker`, the unit cost prefilled from `purchase_cost_defaults` with a hint naming its source (supplier's last cost / product cost / none); a cost typed meanwhile wins. Both: quantity with steppers, never below what was received (`minimumQuantity`), unit cost 0–99,999.99 (0 is a known cost, D24 as amended), the line's expected date, notes, a live line total, and an optional reason once submitted. Edit: Remove line, two steps (a reason unless draft, `ReasonConfirm`), disabled with why once part of the line arrived. The line id is the idempotency key. |
| `SubmitOrderButton`, `CancelOrderControl` (`purchase-order-actions.tsx`) | Submit: one explicit button with a pending state, no confirm, armed 400 ms after it appears. Cancel: `ReasonConfirm` (required reason, the confirm moved and re-keyed, 400 ms guard, "Keep order") saying that items already received stay in stock and that cancelling is final; it sits in its own "Cancel order" card at the bottom. |
| `SupplierSheet`, `NewSupplierButton`, `EditSupplierButton` | Name, contact name, phone, email, website (https:// added when left out), account reference, notes; `newId()` key; values echoed back on failure; Create opens the supplier. |
| `SupplierProductSheet`, `AddSupplierProductButton`, `EditSupplierProductButton` | A supplier–product link: the supplier fixed and the product picked (supplier page), or the product fixed and the supplier picked (product page); supplier SKU, lead days, a Preferred switch whose hint says it replaces another preferred supplier; edit adds Remove link (two steps, no reason: a link is a relationship). Never the last cost: receiving sets it (D63). |
| `SupplierPicker` | `SearchPicker` over active suppliers (`staff_search` kind `supplier`) through `searchSuppliers`. |
| `PurchaseProductPicker` | `SearchPicker` over orderable products (D62: quantity-tracked, shop-owned, active, unarchived) through `searchPurchasableProducts`; each option "On hand N · On order M · P-000123"; products already on the order are shown but not choosable. Not the job-only `searchParts`. |
| `ProductPurchasingCard` (server) | The product page's "Suppliers & orders", above. |
| `ReceiveForm` (`receive-form.tsx`, on `/purchasing/receive/[id]`) | Step 4. A focused page outside `(browse)` (manage_purchasing, real 403): "Receive PO-…", the supplier, a back link, "Received in the last 24 hours" (this PO's receipts of the last 24 hours: the time for today's, the date and time for an earlier day's), then the form. ONE controlled client component, not a form action (React never resets what was typed), running the pure state machine in `src/lib/receive-form.ts` (`receiveReducer`, unit-tested): `starting` → `editing` → `submitting` → done, or `checking` → `recorded` / `notRecorded`, or back to `editing` on a definite refusal, or `closed`. **Key lifecycle:** the receipt's idempotency key is `newId()` when the form first mounts, stored with the values and a `pending` flag in sessionStorage under `bicii:receive:<poId>` (every access in try/catch; the page works without storage); `pending` is set BEFORE the call. A stored key (pending or not) is looked up (`purchase_receipt_by_key`) before anything is editable. The key survives definite refusals (nothing was written under it) and retries; a NEW key comes only with fresh values ("Receive another delivery", whose defaults are the new outstanding quantities); never a new key with old values. **Unknown outcome** (the action threw: network lost, response aborted, or an unexplained failure): the error toast "We could not confirm the receipt. Checking whether it was recorded…" (dismissed once answered), the form read-only with "Checking whether this delivery was recorded…"; found → `recorded`: "This delivery was recorded at 10:42 am by Asha Admin (18 items)", Open PO-… (the receipt's own PO if it differs) and "Receive another delivery"; not found → "It was not recorded. Retrying is safe: it will not be received twice." with Retry (same key, same values; editing allowed, key kept); lookup failed → still read-only with "Check again". `purchase_receipt_key_reused` is treated as found. Definite refusals: `purchase_over_receipt` → editing, `router.refresh()` for the new outstanding numbers and per-line messages; `purchase_order_closed` → the closed state; the D64 date codes → on the Received field. Submitting: inputs read-only, the commit button `aria-busy` and disabled (a ref also drops a second tap before the re-render), "Still confirming…" after 20 s. Success: storage cleared, toast "Received 18 items. 2 still to come." or "Order fully received.", `router.push` to the order. **Lines:** stacked cards on a phone and an upright iPad, a grid with column headers (Product · Ordered · Received · To come · Receive now · Unit cost · Location) once the card is 56rem wide (container query); each line a `role="group"` named by its product. Receive now: `NumberInput` quantity with steppers clamped 0..outstanding, defaulting to the outstanding quantity; more typed shows "Only 2 still to come. Raise the ordered quantity on the order first." (D65) and blocks the commit. Actual unit cost: money, 0 allowed, prefilled with the PO cost, hint "Ordered at $12.00" and a neutral "Differs" badge. Location: a native select (locations are few) following the form-level "Receive into" (default: Phase 4's `defaultLocation()`, or the last one chosen on this device, localStorage `bicii:receive-into`). Lines at 0 are dimmed and not sent; "All to come" and "Clear all". **Duplicate delivery note (D65):** a reference matching one of this PO's receipts (trimmed, case-insensitive) shows "DN-5531 was already recorded at 10:42 am by Asha Admin (18 items)" with a "This is a different delivery" checkbox; the commit stays disabled until it is ticked. **Shop-time date:** a `datetime-local` showing now (shop time, `toShopLocal`); `receivedAt` is sent only when changed (`fromShopLocal(...).toISOString()`), else the server uses now(); min = max(now − 30 days, submitted_at), max = now (D64); the server stays authoritative. **Footer:** sticky above the tab bar and home indicator, ONE row at every width (the summary takes what the button leaves): "N items on M lines", a value preview (lib/money; never authoritative) and "Receive N items" (the explicit commit, no confirm step, SPEC §22; md on a phone, lg from sm). A page with a sticky footer (`data-sticky-footer`, here and on Reorder) gets a root `scroll-padding-bottom` of the footer plus the tab bar (globals.css, `html:has(...)`), so a focused field scrolls clear of them (WCAG 2.4.11). A received or cancelled PO shows the closed state instead ("This order is fully received. Extra or late units go on a new order." with "Start a new order for this supplier", the preset `PurchaseOrderSheet`; or "This order was cancelled."), both linking back. |
| `ReorderList` (`reorder-list.tsx`, on `/purchasing/reorder`) | Step 4 (D66; manage_purchasing, real 403; `PurchasingNav` shows Reorder to manage_purchasing holders; Reorder links also on the Inventory "Low stock" filter and Today's low-stock tile). `SupplierPicker` at the top, required to create, preset from `?supplier=` (choosing one replaces the URL, and the list is remounted keyed by supplier). "Below reorder point" from `reorder_suggestions` (shop-owned products only; a consigned product below its reorder point never appears, D62): each row a 44px `Checkbox` row with the name, P- id, SKU and the supplier's SKU when linked; "On hand 3 / reorder at 10", "On order 2", "Suggested 15" or "Covered by open orders"; badges "Preferred" / "Preferred supplier: …" and "In draft PO-…"; for cost-visible staff the draft's default cost and where it comes from. Rows linked to the chosen supplier with a suggestion above 0 start ticked. Sticky footer "Create draft order (N products)" (full width and allowed to wrap on a phone, so the page never scrolls sideways): `create_purchase_order_from_low_stock` with an id made when the list mounts (a double tap opens the same draft), then the draft, where quantities and costs are edited before Submit. Empty: "Nothing is below its reorder point." with "Shop-owned counted products at or below their reorder point appear here. Consigned stock is never reordered." The Today and Inventory Reorder links follow the general low-stock count, so with only consigned products low they lead to this empty list. |

### Shopify

Phase 10 (SPEC §17, §26; PLAN D80–D89; ADR-020), components in
`src/components/domain/shopify/`, reads and writes in
`src/lib/domain/shopify.ts`, words and tones in `src/lib/shopify.ts`
(every sync, job and event status, outcome and rejection reason has text;
unit-tested), schemas in `src/lib/shopify-forms.ts`.

| Component | Purpose |
|---|---|
| `OnlineCard` | The product page's "Online (Shopify)" card, every staff member: the **Publish online** `Switch` (manage_inventory; `useOptimistic`, toast "Published online" / "Taken offline"; disabled with the reason beside it: "Make the product public first.", customer-owned, archived, no price, or "Needs Manage inventory"); the sync status as a `StatusPill` (synced done, pending progress, error danger, unpublished and not synced neutral) with "Synced 3 min ago" (computed on the server) and "Online quantity 18 at Shop floor"; "Linked to a product made in Shopify: BICII sends price and stock only" for an external origin; on a failed sync the human reason in danger text; **Sync now** with a pending state; a "Test Shopify" badge in fake mode; a folded "Shopify details" with the product and variant gids and Copy (`CopyText`). The actions run only the job id the RPC returned, as best effort after the committed write (if the run cannot happen the toast says "Saved. The sync runs from the queue in a moment."). With the switch on but the product not listed (not public, archived, inactive or customer-owned; `offlineReason`) the description says why instead of "Listed on the Shopify store at its selling price." |
| `QueueList` (client) | The queue's rows as buttons: the kind ("Order", "Refund", "Product sync"), subject, `StatusPill` (needs attention danger, waiting waiting, running progress, done done, dismissed neutral), the human reason clamped to two lines, "Attempt 3 of 8 · next try 2:05 pm" (Singapore time). A row opens a `Sheet` (the job sheet) with the full reason and `JobPanel`; `?job=<id>` opens it on arrival and closing drops the parameter. The sheet keeps only the open job's id and reads the row from the refreshed rows, so after a Retry or a link it shows the new status, attempts, reason and lines; it closes when the job closes or leaves the view, and is not dismissible while a retry or link saves (`JobPanel`'s `onBusyChange`). Its title never repeats the kind (`jobTitle`). |
| `JobPanel` (client) | Retry (primary, one tap, pending state, toast "Recorded as S-000123" or the new reason); per unmapped line with a variant **Link to a BICII product** (inside the job sheet the link form replaces the panel, so no sheet sits on a sheet; on the event page it opens `LinkVariantSheet`); a custom line says "Custom Shopify line — record it by hand if needed, then dismiss"; **Dismiss…** through `ReasonConfirm` (focus to the reason, confirm in another place, the 400 ms guard; an order's copy says its waiting refunds close too); "Open event" from the queue. |
| `LinkVariantForm` / `LinkVariantSheet` | The line title, variant and product gids read-only, the product `SearchPicker` (`searchProductsForLinkAction` over `staff_search`, never a dropdown, SPEC §22), a required reason, **Link and retry**. In `LinkVariantSheet` Cancel and **Link and retry** sit in the sheet footer (`form={formId}`) and the sheet is `dismissible={!pending}`; inside the job sheet the form keeps its own buttons. Cancel, or a link whose retry did not close the item, returns to the panel with focus on that line's **Link to a BICII product** button; only a success closes the item. |
| `LinkCustomerButton` (sheet) | The Shopify customer gid and the order's email; same-email customers first, each labelled "Candidate — same email is not proof"; any customer through `CustomerPicker`; a required reason; the toast says how many earlier online sales show the customer through the Shopify ID (D86). Cancel and **Link customer** in the sheet footer (`form={formId}`), `dismissible={!pending}`. |
| `JsonView` (client) | A stored payload in dense monospace: "Wrap lines" toggle (`aria-pressed`), capped at 60vh until "Show all", Copy; horizontal scroll only inside the block. |
| `ShopifySettingsForm` | `useActionState`: online location (`SegmentedControl` up to four locations, else a native `Select`), storefront address ("Used for the Buy online link on public item pages"), "Record Shopify test orders as sales" `Switch` with "Only for testing. Test orders would count as real sales.", and a reason field, required, shown when that switch changes; refused saves keep what was typed (`values`). |

Screens (admins only, real 403s; filters are `LinkSegments` links so a
view survives reload and sharing, as on `/sales`):

- `/shopify`: a warning banner while test orders are recorded; `StatTile`s
  linking to the lists (Needs attention, danger when above zero; Waiting
  retries; Products online with synced / pending / failed; Events in the
  last 24 hours); the Connection card (Live / Test (fake) / Not connected,
  shop, pinned API version, the webhook address with Copy, whether the
  webhook secret is set, a runbook link); the settings form.
- `/shopify/queue`: Needs attention (default) / Waiting / Recent (done or
  dismissed in 7 days); empty state "Nothing needs attention. Orders and
  product syncs that fail show up here with what to do."
- `/shopify/products`: All / Errors / Pending; name, P- number, status,
  last synced, quantity pushed, the error, "Shopify-made" for an external
  origin; a row opens the product.
- `/shopify/events`: `SearchField` (`?q=` order name or webhook id) and All
  / Failed / Rejected / Processed / Skipped; the topic in words ("Order
  paid", "Refund", else the raw topic), subject, Singapore time,
  "Delivered 2×", "Test", the outcome in a few words, the status; "First
  30 matches" when cut off.
- `/shopify/events/[id]` (`notFound()` for unknown or malformed ids):
  Summary (the outcome in words, linking the sale; a refund says stock was
  not touched, D7, D85), Delivery (ids, shop, API version, times,
  deliveries, signature, the rejection reason in words), Processing
  (attempts, the human error and code, the technical detail folded, the
  job with `JobPanel`), Customer (orders), Headers ("Some headers were
  shortened" when capped), Payload (`JsonView`; a rejected body is never
  stored, D88; a purged one says "Payload removed after the retention
  period").

### Reports

Phase 9 (SPEC §19.2, §21, §22; PLAN D30, D100–D105;
[ADR-022](decisions/ADR-022-reporting.md)). `/reports`, `/reports/lines`
and (Phase 14 step 3) `/reports/payments`, components in
`src/components/domain/reports/` (`report-controls.tsx` client,
`report-sections.tsx` and `payment-sections.tsx` server), reads in
`src/lib/domain/period-reports.ts` over the step 1 RPCs, the vocabulary,
period model and URL state in `src/lib/period-reports.ts`, the CSV export
table in `src/lib/report-exports.ts`.

- **Period and basis live in the URL** (`period, date, from, to, basis,
  by`, and the cursors `after_total, after_key` on `/reports`, `after_at,
  after_id` on `/reports/lines`). `ReportControls`, sticky under the app
  header: the Period segmented control (Day, Week, Month, Custom), a
  stepper ("Previous week" / "Next week", 44 px; Next is disabled when the
  next period would start after today), the range as a button (a native
  date picker for day, week and month; the Custom sheet for a range) and a
  ghost Today when the period does not contain today. `[` and `]` step
  the period when focus is not in a text field. The Custom sheet checks
  the range with the database's own messages (`report_range_invalid`,
  `report_range_too_long`) and keeps the values on an error. Weeks are ISO
  (Monday–Sunday), months calendar months, days shop days. Every change is
  `router.replace` in a transition (scroll and focus kept, a spinner on
  the control), like `SearchField`. `BasisControl` (Sale date, Check-in,
  Completed, Collected, D100) shows the basis's description under it and
  changes only `basis`; changing it keeps the period and `by`.
- **Tiles and cost gating.** The figures are `dl/dt/dd` tiles (Today's
  `StatTile` and `MoneyTile`), two columns on a phone and six across at
  `lg`: Gross sales and "Jobs · sales · lines" always; Direct costs,
  Yield (danger and the word "Loss" when negative), Cult Commons ("Sum of
  30% of each line's positive yield") and BICII after Cult Commons with
  View costs only. A withheld figure (NULL from the database, D30) is
  hidden, never shown as 0; without View costs one line says so. On the
  sale basis a second row adds consignment sales and, with View costs,
  new consignor liability, settlements paid and received from suppliers;
  refunds are their own line, "Refunds recorded: $x (n) — not deducted
  from the figures above" (D102). Lines in another currency are a warning
  linking to `/reports/exceptions` (D104). Without View financial reports
  the financial part is one sentence and there is no basis control.
- **Buckets.** Not for a single day: one row per day, ISO week or month
  (`autoGrain`: days up to 31, weeks up to 184, else months), partial
  buckets marked, with a thin `aria-hidden` bar whose width is the
  bucket's gross over the largest gross (two database strings divided
  with `toDecimal` for presentation only; the value is in text).
- **Breakdown rows versus the table.** A link strip of the dimensions
  (`aria-current` on the chosen one; it changes only `by`). Phones get
  `RowList` rows (label, detail, gross on the right; with View costs
  "Yield $x · CC $y", a loss in danger-deep); from `md` a dense table
  (caption, `th scope`, sticky header, tabular numbers; Qty for products;
  Cost, Yield, Cult Commons and After CC with View costs) scrolling inside
  its own box. 25 groups a page, "Showing the top 25" and "Show more"
  with the keyset cursor. A job or sale group opens its page; every other
  group opens `/reports/lines`. An empty period says "Nothing recorded for
  this period on the <basis> basis." and, on Sale date and Completed,
  "Jobs not completed yet only show on the Check-in basis."
- **Now versus the period.** "Stock at cost now" (D105) is a figure for
  this moment whatever period is chosen, and says so: quantity on hand and
  units per ownership, shop-owned items without a cost ("n items have no
  cost and are not valued"), and with View costs the shop-owned value;
  consigned and customer-owned stock is counted, never valued. Activity
  (everyone) counts each job on its own date (D31), appointments by the
  day they were booked for (D41), and lists jobs by lead mechanic (D103;
  inactive staff marked, lead-less jobs "Unassigned").
- **Export links** are plain `<a target="_blank" rel="noopener">` with an
  `aria-label` naming the table ("Export CSV: breakdown by Job / sale"),
  never `next/link`, whose prefetch would run the export. `_blank` because
  in the iOS standalone PWA a download in the app's own window replaces
  the app with the file; a new window opens Safari's viewer, with Share
  and Save to Files (SPEC §22, ADR-001 A7).
- **No loading.tsx under `/reports`** ([Loading](#loading)):
  `requireStaff()` / `requireStaff('view_financial_reports')` runs before
  anything streams, then each section streams in its own `<Suspense>`
  with a `SectionSkeleton`; a failed section says so in place
  (`SectionLoader`). `/reports/lines` reads its header group before
  streaming, so an unknown key is a real not-found.
- **Customer payments** (Phase 14 step 3; PLAN D154a–e; components in
  `payment-sections.tsx`, server; reads in
  `src/lib/domain/payment-reports.ts`, words and DTOs in
  `src/lib/payment-reports.ts`). A `ReportSection` of the financial part,
  after Breakdown and before Stock at cost now, outside Figures: money
  held, not sales, so `BasisControl` does not apply and the description
  says "Money taken and given back in <range>, by the day it moved,
  whatever the basis." Export CSV (`payments`, the period's movements,
  file named by the range only). Five `MoneyTile`s
  (`report_payment_summary`), two columns on a phone, five across at
  `lg`, Net taken spanning both on a phone: Taken online ("3 payments",
  then "Deposits $x · balances $y"), Refunded online ("1 refund"),
  Recorded at the counter, Given back at the counter (each "n payments")
  and Net taken ("Taken less refunded and given back"; a real minus when
  negative). Two notes: "Not sales: money taken and given back by the day
  it moved." and "Recorded at the counter: only what an admin recorded in
  BICII; not the till's takings." (D154d); when
  `other_currency_count` > 0 a waiting-tone note ("n payments in another
  currency are counted at the amount asked or left out of these totals.")
  with "See exceptions". Then "See each payment", a link to
  `/reports/payments` with the report's parameters. **Held on jobs now**
  (h3, its own Export CSV `payments_held`, a snapshot named by the day):
  "What is held at this moment, whatever period is chosen above.", the
  basis sentence ("Not sales. On the Sale date basis, a job counts as
  sales on the day it is completed, so the second list is already in that
  figure and the others are not."), then always three lists (h4, each a
  region) from `report_payments_held`, in its order: Paid on open jobs,
  Paid on jobs awaiting collection, Paid above the bill. Each heading
  carries its own "Total $x · n jobs" and no grand total is shown
  anywhere (D154c, step3-critique C17); the total is the one display-only
  sum on Reports (Decimal over the RPC's own amounts, never stored or
  exported; the RPC returns no group totals). An empty list says so
  ("No job is paid above its bill."). A row is a `RowLink` to the job:
  job number · customer, the group's amount on the right, and a line
  (`heldJobDetail`): the status, where it was paid ("Paid online", "Paid
  at the counter" or "$A online, $B at the counter"), and "Paid ahead
  $x" (open), "Still to pay $y" (awaiting collection, even with nothing
  paid) or "Paid $x of a $y bill" (above the bill). Each part streams in
  its own `<Suspense>`.
- **`/reports/payments`**, modelled on `/reports/lines`:
  `requireStaff('view_financial_reports')` before anything streams; the
  report's parameters plus the keyset `after_at, after_id`
  (`parsePaymentCursor`: half a cursor or a malformed one is the
  not-found screen, as `report_payment_items` refuses half a cursor).
  Header: "Reports" back link (to `#reports-payments`), the range "· by
  the day the money moved", h1 "Customer payments", the five figures and
  the movement count as a compact `dl`, and the two notes. Then "Payments"
  with Export CSV, newest first, 100 a page ("Back to newest", "Next
  100"): phones and tablets a row per movement (movement and signed
  amount; job link · customer · date; kind · method; "Recorded <when> by
  <who>" on counter rows only, so back-dating shows); from `lg` a dense
  table (Date, Job, Movement, Amount, Customer, Kind, Method, Recorded;
  "—" for Stripe rows, which are Stripe's word), `lg` rather than `md`
  because eight columns beside the sidebar would scroll the amount out of
  sight on an iPad. A refund or a give-back is negative with a
  real minus, in dust-700; "Other currency" is a waiting Badge. A counter
  balance reads "Towards the bill", a Stripe one "Balance", as on the job
  card. An empty period: EmptyState "No customer money moved in this
  period."
- **More reports.** The links at the bottom of `/reports` open
  Exceptions (with the caller's count as a Badge, waiting tone when above
  zero, from `report_exception_counts`; nothing while it loads) and Stock
  reconciliation.

#### Exceptions and reconciliation (Phase 9 step 4)

PLAN D34, D104, D106–D108. `/reports/exceptions` and
`/reports/reconciliation`, both `requireStaff()` (any active staff
member; the database decides which exceptions each person sees, D108),
no `loading.tsx`, each part streamed in its own `<Suspense>`. Words and
URL state in `src/lib/reconciliation.ts`, reads in
`src/lib/domain/reconciliation.ts`.

- **Read-only screens link to the guarded fix, never fix.** Nothing on
  either page changes stock, status or money (D106). A row opens its
  record (product, unit, consignment item, job, sale), where the guarded
  flow lives: Adjust stock with a reason, restock, settle, void, return.
  For adjust_stock holders an issue row on Reconciliation adds "Fix with
  a stock adjustment", a link to the product page where Adjust stock is.
  The only write on either page is the admin's threshold.
- **Exceptions.** PageHeader "Exceptions" ("Things the records say cannot
  be right, or that need someone's attention. They clear themselves when
  the cause is fixed.") with Export CSV. Sections in this order, each an
  h2 with a count Badge and shown only with rows: Stock below zero (with
  a note: a job part may take stock below zero, so count and adjust),
  Items in an impossible state, Shopify needs attention (Phase 10's
  failed jobs, admins only, D86, D108; never a fake row), Customer
  payments (Phase 14: "Customer payment" rows for admins and managers
  with the `payment_issues` sentence as the subject line and "Open the
  job's Customer payments" under it, linking to the job; "Stripe needs
  attention" rows for admins, the outcome's sentence and "Check Stripe
  deliveries in Settings → Customer payments", linking to the job or to
  those deliveries; the sentence is never repeated), Lines in another currency, Unsettled
  consignments, then Overdue jobs, Not collected and Stale holds; a later
  phase's unknown kind falls under "Other". Each section is
  `ExceptionList` with `detailed`: a StatusPill "Critical" (danger) or
  "Needs attention" (waiting) because the heading names the kind, the
  short ID, the title, the subject, the sentence (`exceptionCopy`; for a
  consignment "Sold 45 days ago; $2,000.00 outstanding to <consignor>",
  the amount as the database computed it), the database's detail when it
  says more, and the age ("45 days", the date on hover and "· since
  21 Aug 2026" from md up). Stock and unit rows add a secondary link
  under the row, "Open stock reconciliation", filtered to the product
  (`RowLink`'s `after` slot: links never nest). A line above says how
  many exceptions there are and when they were checked; when the counts
  exceed the 200 listed, it says so. All clear: EmptyState (done tone)
  "No exceptions" with the time checked.
- **Threshold sheet.** Admins see "Alert unsettled consignments after N
  days" and Change, which opens a Sheet ("When to flag unsettled
  consignments") with a quantity `NumberInput` (1–365, steppers, "days"
  suffix) in a Field; the value typed stays on failure with the error
  under the field ([Forms](#forms)); Save closes with a toast "Alert
  unsettled consignments after N days". Everyone else sees the sentence
  as text.
- **Reconciliation.** PageHeader "Stock reconciliation" ("Stock on hand
  is always the sum of the movement ledger. This page checks the records
  that summarise it — each unique item's status and location — against
  that ledger."). A SegmentedControl "Show" (Problems only, the default;
  Everything) kept in the URL as `all=1`, and the `product` filter (set by
  links from Exceptions and from the product page's "Check against the
  ledger") as a removable chip (a link that drops it). Sections: Stock
  below zero (its own note: allowed, but count and adjust), Products by
  location (short ID and name, location, ledger on hand, items in stock
  for unique products, the issue sentence) and Unique items (short ID,
  product, status, location versus "ledger says <location>", the
  disposition with its S-/J- reference, ledger on hand versus expected,
  the issue sentence with the database's detail, last movement date).
  Rows on phones, a dense table from md up (as the breakdown). Clear:
  EmptyState (done tone) "Every product reconciles with the ledger" /
  "Every item reconciles with the ledger". At the RPC cap of 1,000 rows a
  line says "Showing the first 1,000. Choose a product to see the rest."
  Export CSV for products by location and for unique items, honouring
  `all` and `product`.
- **Inventory.** The `/inventory` PageHeader has a "Reconcile stock"
  outline ButtonLink beside Movements.
