'use client';

import ManageView from '@/components/ManageView';
import { Suspense } from 'react';

export default function ManagePage() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <ManageView />
        </Suspense>
    );
}
