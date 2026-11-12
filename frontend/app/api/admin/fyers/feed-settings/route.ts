import { cookies } from "next/headers";
import { NextRequest, NextResponse } from "next/server";

const apiUrl = process.env.API_URL ?? "http://127.0.0.1:8000";

async function forward(request: NextRequest, method: "GET" | "PUT") {
  const access = (await cookies()).get("optionflow_access")?.value;
  if (!access) {
    return NextResponse.json({ detail: "Authentication required" }, { status: 401 });
  }

  try {
    const response = await fetch(`${apiUrl}/admin/fyers/feed-settings`, {
      method,
      headers: {
        Authorization: `Bearer ${access}`,
        ...(method === "PUT" ? { "Content-Type": "application/json" } : {}),
      },
      ...(method === "PUT" ? { body: await request.text() } : {}),
      cache: "no-store",
    });
    const body = await response.json().catch(() => ({
      detail: "Unable to load feed settings.",
    }));
    return NextResponse.json(body, { status: response.status });
  } catch {
    return NextResponse.json(
      { detail: "Unable to reach the market-data service." },
      { status: 502 },
    );
  }
}

export async function GET(request: NextRequest) {
  return forward(request, "GET");
}

export async function PUT(request: NextRequest) {
  return forward(request, "PUT");
}
