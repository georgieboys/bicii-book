// @vitest-environment node
/**
 * listPhotos' URLs (src/lib/domain/attachments.ts; audit 2026-10-18): a
 * grid shows a 480 px rendition when Storage resizes images
 * (STORAGE_IMAGE_TRANSFORMS=true), else the original; the viewer always
 * gets the original. A thumbnail Storage cannot sign falls back to the
 * original.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const env: { STORAGE_IMAGE_TRANSFORMS?: "true" } = {};
vi.mock("@/lib/env", () => ({ getServerEnv: () => env }));

const { listPhotos } = await import("@/lib/domain/attachments");
import type { ServerSupabase } from "@/lib/supabase/server";

const row = (id: string, bucket: string, path: string) => ({
  id,
  entity_type: "work_order",
  entity_id: "job-1",
  storage_bucket: bucket,
  storage_path: path,
  visibility: bucket === "media-public" ? "public" : "internal",
  caption: null,
  media_type: "image/jpeg",
  width: 2048,
  height: 1536,
  byte_size: 600_000,
  created_at: "2026-10-18T00:00:00Z",
});

function supabaseWith({ thumbFails = false } = {}) {
  const signedOne = vi.fn(async (path: string, _ttl: number, opts?: { transform?: unknown }) =>
    thumbFails
      ? { data: null, error: { message: "transform failed" } }
      : {
          data: { signedUrl: `https://s/render/${path}?w=${JSON.stringify(opts?.transform)}` },
          error: null,
        },
  );
  const query = {
    select: () => query,
    eq: () => query,
    order: async () => ({
      data: [row("a", "media-internal", "job/a.jpg"), row("b", "media-public", "job/b.jpg")],
      error: null,
    }),
  };
  const client = {
    from: () => query,
    rpc: async () => ({ data: [], error: null }),
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[]) => ({
          data: paths.map((p) => ({ path: p, signedUrl: `https://s/sign/${p}`, error: null })),
          error: null,
        }),
        createSignedUrl: signedOne,
        getPublicUrl: (path: string, opts?: { transform?: unknown }) => ({
          data: {
            publicUrl: opts?.transform
              ? `https://s/render/public/${bucket}/${path}`
              : `https://s/object/public/${bucket}/${path}`,
          },
        }),
      }),
    },
  };
  return { supabase: client as unknown as ServerSupabase, signedOne };
}

const target = { entityType: "work_order" as const, entityId: "job-1" };

afterEach(() => {
  delete env.STORAGE_IMAGE_TRANSFORMS;
});

describe("listPhotos URLs", () => {
  it("without resizing, the grid gets the original and no rendition is signed", async () => {
    const { supabase, signedOne } = supabaseWith();
    const [a, b] = await listPhotos(supabase, target);
    expect(a).toMatchObject({
      url: "https://s/sign/job/a.jpg",
      thumbUrl: "https://s/sign/job/a.jpg",
    });
    expect(b).toMatchObject({
      url: "https://s/object/public/media-public/job/b.jpg",
      thumbUrl: "https://s/object/public/media-public/job/b.jpg",
    });
    expect(signedOne).not.toHaveBeenCalled();
  });

  it("with resizing, the grid gets a 480 px rendition and the viewer the original", async () => {
    env.STORAGE_IMAGE_TRANSFORMS = "true";
    const { supabase, signedOne } = supabaseWith();
    const [a, b] = await listPhotos(supabase, target);
    expect(a.url).toBe("https://s/sign/job/a.jpg");
    expect(a.thumbUrl).toContain("https://s/render/job/a.jpg");
    expect(a.thumbUrl).toContain('"width":480');
    expect(b.url).toBe("https://s/object/public/media-public/job/b.jpg");
    expect(b.thumbUrl).toBe("https://s/render/public/media-public/job/b.jpg");
    // One signed rendition per private photo; public renditions need no request.
    expect(signedOne).toHaveBeenCalledTimes(1);
  });

  it("falls back to the original when a rendition cannot be signed", async () => {
    env.STORAGE_IMAGE_TRANSFORMS = "true";
    const { supabase } = supabaseWith({ thumbFails: true });
    const [a] = await listPhotos(supabase, target);
    expect(a).toMatchObject({
      url: "https://s/sign/job/a.jpg",
      thumbUrl: "https://s/sign/job/a.jpg",
    });
  });
});
