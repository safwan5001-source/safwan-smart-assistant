"use client";
import { useState } from "react";
import Icon from "@/components/icon";
import { brandFor, NEUTRAL_ICONS } from "@/lib/integration-brands";
import type { IntegrationDef } from "@/lib/integrations";

type Props = {
  integration: Pick<IntegrationDef, "id" | "name">;
  size?: "sm" | "md";
};

/** Brand tile for an integration: official logo when we have one, otherwise a neutral icon or monogram.
 *  Decorative (aria-hidden): the name and status are always rendered as text next to it. */
export default function IntegrationLogo({ integration, size = "md" }: Props) {
  const [broken, setBroken] = useState(false);
  const brand = brandFor(integration.id);
  const mark = brand?.mark;
  const neutral = NEUTRAL_ICONS[integration.id];
  const showImage = mark?.kind === "image" && !broken;
  const kind = mark?.kind === "glyph" ? "glyph" : showImage ? "image" : "fallback";

  return (
    <span className="int-logo" data-kind={kind} data-size={size} aria-hidden="true"
      style={mark?.kind === "glyph" ? ({ "--brand-fg": mark.color.light, "--brand-fg-dark": mark.color.dark } as React.CSSProperties) : undefined}>
      {mark?.kind === "glyph" ? (
        <svg viewBox={mark.viewBox} focusable="false"><path d={mark.path} /></svg>
      ) : showImage ? (
        // Plain <img>: these are tiny static SVGs, so next/image optimisation would add nothing.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mark.src} alt="" width={24} height={24} decoding="async" loading="lazy" onError={() => setBroken(true)} />
      ) : neutral ? (
        <Icon name={neutral} size={size === "sm" ? 18 : 22} />
      ) : (
        <span className="int-mono">{integration.name.trim().slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
}
