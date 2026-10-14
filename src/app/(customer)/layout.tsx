import Image from "next/image";

/**
 * Pages for the shop's customers inside the Admin (Phase 13 step 3: the
 * quote page, D143). No staff shell, no navigation into the Admin: the
 * brand, then the page, on paper.
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
    </main>
  );
}
