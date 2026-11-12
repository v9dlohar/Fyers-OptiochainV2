import { cookies } from "next/headers";
import { NextResponse } from "next/server";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:8000";

export async function GET() {
  const access = (await cookies()).get("optionflow_access")?.value;
  if (!access) {
    return NextResponse.json({ detail: "Authentication required" }, { status: 401 });
  }

  try {
    const response = await fetch(`${apiUrl}/admin/fyers/api-usage`, {
      headers: { Authorization: `Bearer ${access}` },
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({
      detail: "Unable to load Fyers API usage.",
    }));
    return NextResponse.json(body, { status: response.status });
  } catch {
    return NextResponse.json(
      { detail: "Unable to reach the market-data service." },
      { status: 502 },
    );
  }
}
