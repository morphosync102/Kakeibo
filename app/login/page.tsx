import { Suspense } from "react";
import { connection } from "next/server";
import { isPasswordLoginEnabled } from "@/lib/session";
import LoginForm from "./LoginForm";

// Rendered per request: the password form exists only while APP_PASSWORD is
// set (migration period, design §3.10). Passkey login is always offered.
export default async function LoginPage() {
    await connection();
    const passwordEnabled = isPasswordLoginEnabled(process.env);
    return (
        <Suspense fallback={<div>Loading...</div>}>
            <LoginForm passwordEnabled={passwordEnabled} />
        </Suspense>
    );
}
