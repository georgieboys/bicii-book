import Image from "next/image";

import { SHOP_CONTACT } from "@/lib/shop-contact";

/**
 * Pages for the shop's customers inside the Admin (Phase 13 step 3: the
 * quote page, D143; Phase 14 step 3: the payment link, D156f). No staff
 * shell, no navigation into the Admin: the brand, then the page, on paper,
 * and a way to reach the shop under every page (U2-14: the pages say "ask
 * the shop" in several places).
 */
export default function CustomerLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="gutter mx-auto flex w-full max-w-xl flex-1 flex-col gap-8 py-[max(2rem,env(safe-area-inset-top))]">
      <Image
        src="/logo.svg"
        alt="BICII"
        width={2016}
        height={952}
        unoptimized
        loading="eager"
        className="h-8 w-auto self-start"
      />
      {children}
      <footer className="mt-auto border-t border-hairline pt-4 text-sm text-dust-700">
        Questions?{" "}
        <a
          href={SHOP_CONTACT.href}
          className="font-medium underline decoration-2 underline-offset-4"
        >
          {SHOP_CONTACT.label}
        </a>
      </footer>
    </main>
  );
}
