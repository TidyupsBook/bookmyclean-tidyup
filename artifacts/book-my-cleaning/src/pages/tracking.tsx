import { Redirect } from "wouter";

/** Legacy bookmark target; live location administration lives on Live Map. */
export function TrackingPage() {
  return <Redirect to="/map" />;
}

export { DeviceRow } from "@/components/DeviceManager";
export default TrackingPage;
