import type { Metadata } from "next";

import { ToolCatalog } from "@/components/tool-catalog";
import { loadToolCatalogSnapshot } from "@/lib/tools/catalog-view";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Tool catalog",
  description: "Browse agent tools, schemas, backing implementations, and runtime access.",
};

export default async function ToolsPage() {
  const snapshot = await loadToolCatalogSnapshot();

  return <ToolCatalog snapshot={snapshot} />;
}
