import type { Metadata, Viewport } from "next";
import BodyBackgroundSetter from "@/components/BodyBackgroundSetter";

export const viewport: Viewport = {
    themeColor: "#020617", // Dark color matching bg-slate-950
};

export const metadata: Metadata = {
    title: "Yahoo Card Kakeibo",
    manifest: "/yahoo-manifest.json",
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: "Yahoo Kakeibo",
    },
    icons: {
        icon: '/psyduck.png',
        apple: '/psyduck.png',
    },
};

export default function YahooLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <>
            <BodyBackgroundSetter color="#020617" />
            {children}
        </>
    );
}
