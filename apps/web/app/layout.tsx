import type { ReactNode } from "react";
import { Rubik } from "next/font/google";
import "./globals.css";

const rubik = Rubik({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-rubik" });

export const metadata = { title: "Painel SDR — Poli" };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" className={rubik.variable}>
      <body>{children}</body>
    </html>
  );
}
