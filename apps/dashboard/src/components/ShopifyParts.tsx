/** Small pieces shared by the Shopify store views (§15.5): product pictures and the storefront link. */
import { useState } from "react";
import { storefrontHost, storefrontOrigin } from "../shopify";
import type { ShopifyStoreRef } from "../types";
import { ExternalLink, ShoppingBag } from "./Icons";

/**
 * A row of up to four product pictures from the store's CDN (or the mock's inline SVGs). Fixed
 * square boxes, lazy, sent without a referrer; a picture that fails becomes a quiet bag tile.
 */
export function SampleImages({ images, label }: { images: string[]; label: string }) {
  if (!images.length) return null;
  return (
    <ul className="shop-samples" aria-label={`Products at ${label}`}>
      {images.map((src, i) => (
        <li key={`${i}:${src.slice(0, 80)}`}>
          <SampleImage src={src} />
        </li>
      ))}
    </ul>
  );
}

function SampleImage({ src }: { src: string }) {
  const [broken, setBroken] = useState(false);
  return (
    <span className={`shop-sample${broken ? " shop-sample-broken" : ""}`}>
      <ShoppingBag aria-hidden className="shop-sample-bag" />
      {!broken && <img src={src} alt="" loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setBroken(true)} />}
    </span>
  );
}

/** "allbirds.com ↗", opening the public storefront (never a store admin). Plain text when there's no storefront. */
export function StorefrontLink({ shop, className = "shop-link" }: { shop: Pick<ShopifyStoreRef, "storefrontUrl" | "domain">; className?: string }) {
  const href = storefrontOrigin(shop.storefrontUrl);
  const host = storefrontHost(shop);
  if (!href) return <span>{host}</span>;
  return (
    <a className={className} href={href} target="_blank" rel="noopener noreferrer">
      {host} <ExternalLink width={14} height={14} />
    </a>
  );
}
