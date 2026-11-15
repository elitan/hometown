// The root layout: the map fills the window, so it only loads fonts and styles.
import "@fontsource-variable/inter";
import "@fontsource-variable/fraunces";
import "./styles.css";
import type { LayoutProps } from "northstack";

export default function RootLayout({ children }: LayoutProps) {
  return <>{children}</>;
}
