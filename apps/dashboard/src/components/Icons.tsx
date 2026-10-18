/**
 * The dashboard's icons: Lucide (https://lucide.dev, ISC), the same set the agent chat uses, at one
 * stroke weight. Names stay ours so call sites read as what the icon means; stroke inherits
 * currentColor so status colour never stands alone.
 */
import type { SVGProps } from "react";
import {
  AlarmClock,
  ArrowDownLeft,
  Banknote,
  ChartLine,
  ArrowUpRight,
  Check as LucideCheck,
  ChevronRight,
  CreditCard as LucideCreditCard,
  ExternalLink as LucideExternalLink,
  Landmark,
  RotateCw,
  ShoppingBag as LucideShoppingBag,
  Clock as LucideClock,
  Info as LucideInfo,
  Lock as LucideLock,
  Moon as LucideMoon,
  Plug as LucidePlug,
  Plus as LucidePlus,
  Search as LucideSearch,
  ShieldX,
  Snowflake as LucideSnowflake,
  Sun as LucideSun,
  TriangleAlert,
  Unplug as LucideUnplug,
  X,
  Zap,
  type LucideIcon,
} from "lucide-react";

type IconProps = SVGProps<SVGSVGElement>;

const icon = (Glyph: LucideIcon) => {
  const Icon = (p: IconProps) => <Glyph size={22} strokeWidth={1.75} aria-hidden {...(p as object)} />;
  Icon.displayName = Glyph.displayName;
  return Icon;
};

export const ArrowOut = icon(ArrowUpRight);
export const ArrowIn = icon(ArrowDownLeft);
export const Shield = icon(ShieldX);
export const Snowflake = icon(LucideSnowflake);
export const Clock = icon(LucideClock);
export const Check = icon(LucideCheck);
export const Cross = icon(X);
export const Plus = icon(LucidePlus);
export const Bolt = icon(Zap);
export const Info = icon(LucideInfo);
export const Sun = icon(LucideSun);
export const Plug = icon(LucidePlug);
export const Unplug = icon(LucideUnplug);
export const Search = icon(LucideSearch);
export const Moon = icon(LucideMoon);
export const Warn = icon(TriangleAlert);
export const Close = icon(X);
export const Chevron = icon(ChevronRight);
export const Lock = icon(LucideLock);
/** Shopify stores (§15): a shopping bag, drawn on Shopify green by `ServiceTile shopify`. */
export const ShoppingBag = icon(LucideShoppingBag);
export const ExternalLink = icon(LucideExternalLink);
/** A payment card: the single-use Allowance Card that pays Shopify stores (§15). */
export const CreditCard = icon(LucideCreditCard);
/** A bank building (Capital One, §16). */
export const Bank = icon(Landmark);
export const Retry = icon(RotateCw);
/** A schedule the agent set for itself (§20.3). */
export const Alarm = icon(AlarmClock);
/** An owner rule or a price watch (§20.3), and the paper brokerage. */
export const Chart = icon(ChartLine);
/** Money going back to the owner (§20.2). */
export const CashOut = icon(Banknote);
