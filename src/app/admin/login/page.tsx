import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  ADMIN_SESSION_COOKIE_NAME,
  verifyAdminSessionToken,
} from "@/lib/adminAuth";
import { LoginForm } from "./_components/LoginForm";

type AdminLoginPageProps = Readonly<{
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}>;

function firstSearchParam(
  value: string | string[] | undefined,
): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function getSafeAdminDestination(value: string | undefined): string {
  if (
    !value ||
    value.startsWith("//") ||
    value.includes("\\") ||
    /[\r\n]/u.test(value)
  ) {
    return "/admin";
  }

  try {
    const baseUrl = new URL("https://glowrunners.invalid");
    const destinationUrl = new URL(value, baseUrl);
    const isAdminDestination =
      destinationUrl.pathname === "/admin" ||
      destinationUrl.pathname.startsWith("/admin/");
    const isLoginDestination =
      destinationUrl.pathname === "/admin/login" ||
      destinationUrl.pathname.startsWith("/admin/login/");

    if (
      destinationUrl.origin !== baseUrl.origin ||
      !isAdminDestination ||
      isLoginDestination
    ) {
      return "/admin";
    }

    return `${destinationUrl.pathname}${destinationUrl.search}`;
  } catch {
    return "/admin";
  }
}

export default async function AdminLoginPage({
  searchParams,
}: AdminLoginPageProps) {
  const params = await searchParams;
  const nextPath = getSafeAdminDestination(firstSearchParam(params?.next));
  const cookieStore = await cookies();
  const existingSession = await verifyAdminSessionToken(
    cookieStore.get(ADMIN_SESSION_COOKIE_NAME)?.value,
  );

  if (existingSession !== null) {
    redirect(nextPath);
  }

  return (
    <main className="flex min-h-screen w-full flex-col items-center justify-start overflow-x-hidden bg-black px-4 text-white">
      <div className="box-border flex w-full max-w-md flex-col gap-4 py-6">
        <section
          aria-labelledby="admin-login-heading"
          className="w-full min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950 p-5 shadow-[0_0_24px_rgba(245,158,11,0.12)]"
        >
          <p className="text-xs font-black uppercase tracking-[0.18em] text-amber-300">
            GlowRunners Gate Control
          </p>
          <h1
            id="admin-login-heading"
            className="mt-2 break-words text-3xl font-black leading-tight text-white"
          >
            Admin sign in
          </h1>
          <p className="mt-3 text-sm font-semibold leading-6 text-zinc-400">
            Use your approved Egyptian mobile number and the private event
            access code.
          </p>

          <LoginForm nextPath={nextPath} />
        </section>

        <Link
          className="flex min-h-12 w-full min-w-0 items-center justify-center rounded-xl border border-zinc-800 px-4 py-3 text-sm font-black text-zinc-300 transition hover:border-zinc-600 hover:text-white"
          href="/"
        >
          Back to event home
        </Link>
      </div>
    </main>
  );
}
