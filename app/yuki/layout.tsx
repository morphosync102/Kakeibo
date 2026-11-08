import type { Metadata, Viewport } from "next";
import BodyBackgroundSetter from "@/components/BodyBackgroundSetter";
import { SOURCES } from "@/lib/sources";

// Yuki's kakeibo: light pink theme (design 2026-11-yuki-and-passkeys §4.4-4.5).
// The icon reuses the shared app image until a Yuki icon is provided.
export const viewport: Viewport = {
    themeColor: SOURCES.yuki.theme.themeColor,
};

export const metadata: Metadata = {
    title: "Yuki Kakeibo",
    manifest: "/yuki-manifest.json",
    appleWebApp: {
        capable: true,
        statusBarStyle: "default",
        title: "Yuki Kakeibo",
    },
    icons: {
        icon: '/image.png',
        apple: '/image.png',
    },
};

export default function YukiLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    return (
        <>
            <BodyBackgroundSetter color={SOURCES.yuki.theme.background} />
            {children}
        </>
    );
}
