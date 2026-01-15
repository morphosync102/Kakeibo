import { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
    return {
        name: 'Kakeibo',
        short_name: 'Kakeibo',
        description: 'Personal Finance Tracker',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',
        theme_color: '#ffffff',
        icons: [
            {
                src: '/image.png',
                sizes: '192x192',
                type: 'image/png',
            },
            {
                src: '/image.png',
                sizes: '512x512',
                type: 'image/png',
            },
        ],
    };
}
