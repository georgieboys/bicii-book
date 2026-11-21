-- ---------------------------------------------------------------------------
-- Staff writes to media-public take only the copy of a recorded internal
-- photo (audit 2026-11-13 A-24; DATA-MODEL §8).
--
-- 20261018000200_storage_path_policies limited media_public_insert_staff to
-- an attachment's own path shape, but any active staff member could still
-- put a file there that no attachments row points at, under any entity type.
-- The only staff write the app makes to media-public is the copy step of a
-- visibility move (src/lib/domain/attachments.ts setPhotoVisibility): the
-- object is copied from media-internal to the same path, and only then does
-- set_attachment_visibility point the row at it. At that moment the row
-- still names the media-internal object at that path.
--
-- The policy now also requires:
--   * an entity type that can be public: never customer
--     (attachments_customer_never_public), consignment_item (D52) or
--     work_order (D19), which the RPCs and triggers already keep private;
--   * an attachments row that currently points at the same path in
--     media-internal (private.attachment_object_referenced), so the write
--     is the copy of an existing recorded internal photo.
-- Select and delete are unchanged; the service role is unaffected.
-- ---------------------------------------------------------------------------

drop policy media_public_insert_staff on storage.objects;

create policy media_public_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media-public'
    and name ~ '^(bike|work_order|product|inventory_unit|customer|consignment_item)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp|heic|heif)$'
    and pg_catalog.split_part(name, '/', 1) not in ('customer', 'consignment_item', 'work_order')
    and (select private.is_staff())
    and private.attachment_object_referenced('media-internal', name)
  );
