import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import { Geist, Fraunces } from "next/font/google";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});
// Display face for the app's big headings (the Eliora wordmark and page titles).
// Fraunces is a warm, high-contrast serif — it gives the wordmark some character
// without the novelty-script feel of the old face.
const fraunces = Fraunces({
  subsets: ["latin"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "Eliora — your learning guide",
  description:
    "An adaptive learning-plan chatbot for learners who struggle with learning.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={cn("font-sans", geist.variable, fraunces.variable)}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
