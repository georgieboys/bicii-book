-- ---------------------------------------------------------------------------
-- Staff uploads to the photo buckets take only an attachment's own path
-- (audit 2026-10-18; DATA-MODEL §8).
--
-- The insert policies of 20261004000800_media_storage let any active staff
-- member put an object at any path in media-internal and media-public, so
-- the public bucket could serve a file no attachments row points at. Both
-- now also require the path shape attachments_path_shape enforces
-- (20261004000900_attachments): {entity type}/{entity id}/{attachment id}
-- with an image extension, ids as lower-case UUIDs. Signed upload URLs
-- (prepareUploads) and the internal-to-public copy (a visibility change)
-- already use exactly that path. Select and delete are unchanged; the
-- service role is unaffected.
-- ---------------------------------------------------------------------------

drop policy media_internal_insert_staff on storage.objects;
drop policy media_public_insert_staff on storage.objects;

create policy media_internal_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media-internal'
    and name ~ '^(bike|work_order|product|inventory_unit|customer|consignment_item)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp|heic|heif)$'
    and (select private.is_staff())
  );

create policy media_public_insert_staff on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'media-public'
    and name ~ '^(bike|work_order|product|inventory_unit|customer|consignment_item)/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp|heic|heif)$'
    and (select private.is_staff())
  );
