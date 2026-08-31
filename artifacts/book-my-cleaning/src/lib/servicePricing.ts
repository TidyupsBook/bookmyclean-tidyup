type PricedService = {
  name: string;
  priceMin?: number | null;
  priceMax?: number | null;
};

/**
 * A catalog service can prefill a quote only when it has one exact price.
 * Ranges remain useful guidance for the receptionist, but choosing one end
 * silently would promise the customer a number the owner did not choose.
 */
export function exactServicePrice(
  services: PricedService[] | undefined,
  serviceName: string,
): number | null {
  const wanted = serviceName.trim().toLocaleLowerCase();
  if (!wanted) return null;
  const service = services?.find(
    (candidate) => candidate.name.trim().toLocaleLowerCase() === wanted,
  );
  if (
    service?.priceMin == null ||
    service.priceMax == null ||
    service.priceMin !== service.priceMax
  ) {
    return null;
  }
  return service.priceMin;
}
