import { createFileRoute } from "@tanstack/react-router";
import Hometown from "../components/Hometown";

// The map. The place lives in the URL hash (#Mala, Hässleholm), which Hometown reads and writes itself.
export const Route = createFileRoute("/")({
  component: Hometown,
});
