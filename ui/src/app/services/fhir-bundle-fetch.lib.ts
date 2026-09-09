// Author: Preston Lee

import type { Bundle } from 'fhir/r4';
import { mergeBundles } from './sql-on-fhir/sql-on-fhir-execution-data.lib';

export async function fetchAllBundlePages(
  initialBundle: Bundle,
  fetchPage: (url: string) => Promise<Bundle>,
  onPage?: (page: Bundle) => void,
): Promise<Bundle> {
  onPage?.(initialBundle);
  const bundles: Bundle[] = [initialBundle];
  let nextUrl = initialBundle.link?.find(l => l.relation === 'next')?.url;
  while (nextUrl?.trim()) {
    const page = await fetchPage(nextUrl);
    onPage?.(page);
    bundles.push(page);
    nextUrl = page.link?.find(l => l.relation === 'next')?.url;
  }
  return mergeBundles(bundles);
}
