type GeocodeAddressComponent = {
  long_name: string;
  types: string[];
};

export type GeocodeResult = {
  formatted_address?: string;
  types?: string[];
  address_components?: GeocodeAddressComponent[];
};

const POI_RESULT_TYPES = new Set([
  'point_of_interest',
  'establishment',
  'park',
  'natural_feature',
  'tourist_attraction',
  'premise',
]);

const POI_COMPONENT_TYPES = [
  'point_of_interest',
  'establishment',
  'park',
  'natural_feature',
  'tourist_attraction',
  'premise',
];

const FALLBACK_COMPONENT_TYPES = [
  'neighborhood',
  'sublocality',
  'sublocality_level_1',
  'locality',
  'administrative_area_level_2',
  'route',
];

function firstSegment(formatted?: string): string | null {
  const seg = formatted?.split(',')[0]?.trim();
  return seg || null;
}

function componentName(
  result: GeocodeResult,
  types: readonly string[]
): string | null {
  const components = result.address_components || [];
  for (const type of types) {
    const comp = components.find((c) => c.types.includes(type));
    if (comp?.long_name) return comp.long_name;
  }
  return null;
}

/** Best short place name from Google Geocoding API reverse-geocode results. */
export function locationNameFromGeocodeResults(
  results: GeocodeResult[] | undefined
): string | null {
  if (!results?.length) return null;

  for (const result of results) {
    const types = result.types || [];
    if (!types.some((t) => POI_RESULT_TYPES.has(t))) continue;
    const name =
      componentName(result, POI_COMPONENT_TYPES) ||
      firstSegment(result.formatted_address);
    if (name) return name;
  }

  for (const result of results) {
    const name = componentName(result, FALLBACK_COMPONENT_TYPES);
    if (name) return name;
  }

  return firstSegment(results[0].formatted_address);
}

/** Place name from a Places Autocomplete prediction (main_text is the short label). */
export function locationNameFromAutocomplete(item: {
  description?: string;
  structured_formatting?: { main_text?: string };
}): string | null {
  const main = item.structured_formatting?.main_text?.trim();
  if (main) return main;
  return firstSegment(item.description);
}
