import { Suspense } from "react";
import LoginForm from "./LoginForm";

// Passkey login only (the shared-password login was removed, design §3.10 /
// §11 U6). Also the app lock screen (?reason=locked, §3.12).
export default function LoginPage() {
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <LoginForm />
        </Suspense>
    );
}
