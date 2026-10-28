import type { Metadata } from "next";

import { Scanner } from "@/components/domain/scanner";
import { PageHeader } from "@/components/ui/page-header";
import { requireStaff } from "@/lib/auth/session";
import { scanBases } from "@/lib/qr";

export const metadata: Metadata = { title: "Scan" };

/**
 * QR scanning (SPEC §20, PLAN D9): the camera reads a BICII label and
 * opens its record through /q/{shortId}; the code printed under the QR can
 * be typed instead. The accepted label bases come from src/lib/qr.ts
 * (scanBases: the database QR base, the environment's public site URL and
 * the retired bases).
 */
export default async function ScanPage() {
  await requireStaff();
  const bases = await scanBases();
  return (
    <>
      <PageHeader
        title="Scan"
        description="Point the camera at a BICII QR label to open the bike, job, product or unit."
      />
      <Scanner publicBases={bases} />
    </>
  );
}
