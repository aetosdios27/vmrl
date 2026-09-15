import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "VMRL | Release Artifact Verification",
  description: "Verify release artifact digests against on-chain receipts and an explicitly trusted publisher.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        {children}
      </body>
    </html>
  );
}
