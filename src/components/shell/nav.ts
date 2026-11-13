import type { ComponentType, SVGProps } from "react";

import {
  BagIcon,
  BikeIcon,
  BoxIcon,
  CalendarIcon,
  ChartIcon,
  HomeIcon,
  MoreIcon,
  PrinterIcon,
  ReceiptIcon,
  RouteIcon,
  ScanIcon,
  SettingsIcon,
  TagIcon,
  TruckIcon,
  UsersIcon,
  WrenchIcon,
} from "@/components/ui/icons";

export type NavItem = {
  href: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
  /** One line for the More list. */
  description?: string;
  /** Other sections this item is active for (Inventory: products and units). */
  also?: readonly string[];
  /**
   * Only admins can open it (its pages call requireAdmin()), so it is not
   * listed for anyone else (as /settings hides Labels and Staff).
   */
  adminOnly?: boolean;
};

/** Bottom tab bar on phones; Scan sits in the middle, raised. */
export const TABS: readonly NavItem[] = [
  { href: "/", label: "Today", icon: HomeIcon },
  { href: "/jobs", label: "Jobs", icon: WrenchIcon },
  { href: "/scan", label: "Scan", icon: ScanIcon },
  { href: "/inventory", label: "Inventory", icon: BoxIcon, also: ["/products", "/units"] },
  { href: "/more", label: "More", icon: MoreIcon },
];

/** Everything else, listed on /more and in the iPad rail. */
export const MORE_ITEMS: readonly NavItem[] = [
  {
    href: "/customers",
    label: "Customers",
    icon: UsersIcon,
    description: "People and contact details",
  },
  { href: "/bikes", label: "Bikes", icon: BikeIcon, description: "Bikes and service history" },
  {
    href: "/appointments",
    label: "Appointments",
    icon: CalendarIcon,
    description: "Bookings, shop hours and capacity",
  },
  {
    href: "/adventures",
    label: "Adventures",
    icon: RouteIcon,
    description: "Routes, certification offers and prices",
  },
  {
    href: "/consignment",
    label: "Consignment",
    icon: TagIcon,
    description: "Consignors, items and settlements",
  },
  {
    href: "/sales",
    label: "Sales",
    icon: ReceiptIcon,
    description: "In-store sales, refunds and restocks",
  },
  {
    href: "/shopify",
    label: "Shopify",
    icon: BagIcon,
    description: "Online sync, orders and errors",
    adminOnly: true,
  },
  {
    href: "/purchasing",
    label: "Purchasing",
    icon: TruckIcon,
    description: "Suppliers, orders and receiving",
  },
  { href: "/labels", label: "Labels", icon: PrinterIcon, description: "QR labels and print jobs" },
  { href: "/reports", label: "Reports", icon: ChartIcon, description: "Daily and period reports" },
  {
    href: "/settings",
    label: "Settings",
    icon: SettingsIcon,
    description: "Profile, staff and app",
  },
];

/** The More destinations this staff member can open (admin-only ones for admins). */
export function moreItemsFor(isAdmin: boolean): readonly NavItem[] {
  return MORE_ITEMS.filter((item) => !item.adminOnly || isAdmin);
}

/** True when `pathname` is `href` or below it ("/" only matches itself). */
export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** True when `pathname` is in the item's section or one of its `also` sections. */
export function isItemActive(pathname: string, item: Pick<NavItem, "href" | "also">): boolean {
  return (
    isActive(pathname, item.href) || (item.also ?? []).some((href) => isActive(pathname, href))
  );
}

/** The More tab is active for every destination it lists. */
export function isMoreActive(pathname: string): boolean {
  return isActive(pathname, "/more") || MORE_ITEMS.some((item) => isItemActive(pathname, item));
}
