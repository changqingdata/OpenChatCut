// The provider registry.
//
// Declarative on purpose: adding a platform is a row here plus an adapter, never
// a change to the callers. A provider whose key is missing reports itself
// unavailable instead of throwing, so one unconfigured platform cannot break a
// search that the others can answer.

import { PrivateAudioCatalog } from './catalog.ts';
import { PexelsProvider, PixabayProvider, readProviderKeys } from './search.ts';
import type { MaterialItem, MaterialProvider, MaterialQuery, MaterialRole } from './types.ts';

export interface SearchOutcome {
  items: MaterialItem[];
  /** Providers that answered, and those that failed — surfaced, not swallowed. */
  answered: string[];
  failures: Array<{ provider: string; error: string }>;
  skipped: string[];
}

export async function createProviders(envPath = '.env.local'): Promise<MaterialProvider[]> {
  const keys = await readProviderKeys(envPath);
  return [
    new PrivateAudioCatalog(),
    new PexelsProvider(keys.pexels),
    new PixabayProvider(keys.pixabay),
  ];
}

/**
 * Query every available provider that serves the requested role, then merge.
 *
 * A provider that fails does not abort the search: stock platforms rate-limit
 * and time out routinely, and a partial result is still useful. The failures are
 * returned so the caller can report them rather than pretend the list is whole.
 */
export async function searchAll(
  providers: readonly MaterialProvider[],
  query: MaterialQuery,
  envPath = '.env.local',
): Promise<SearchOutcome> {
  void envPath;
  const outcome: SearchOutcome = { items: [], answered: [], failures: [], skipped: [] };

  for (const provider of providers) {
    if (!provider.roles.includes(query.role)) continue;
    if (!(await provider.available())) {
      outcome.skipped.push(provider.id);
      continue;
    }
    try {
      const items = await provider.search(query);
      outcome.items.push(...items);
      outcome.answered.push(provider.id);
    } catch (error) {
      outcome.failures.push({
        provider: provider.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}

/** Roles that at least one configured provider can serve. */
export async function availableRoles(providers: readonly MaterialProvider[]): Promise<MaterialRole[]> {
  const roles = new Set<MaterialRole>();
  for (const provider of providers) {
    if (!(await provider.available())) continue;
    for (const role of provider.roles) roles.add(role);
  }
  return [...roles];
}
