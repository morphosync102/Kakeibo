'use client';

import { useEffect } from 'react';

export default function BodyBackgroundSetter({ color }: { color: string }) {
    useEffect(() => {
        // Save original background color
        const originalColor = document.body.style.backgroundColor;

        // Set new background color
        document.body.style.backgroundColor = color;

        // Cleanup on unmount
        return () => {
            document.body.style.backgroundColor = originalColor;
        };
    }, [color]);

    return null;
}
