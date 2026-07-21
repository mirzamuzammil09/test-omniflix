import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get("url");

  if (!url) {
    return new NextResponse("URL parameter is required", { status: 400 });
  }

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://boredflix.cc/",
        "Origin": "https://boredflix.cc"
      }
    });

    if (!res.ok) {
      return new NextResponse(`Failed to fetch subtitle (HTTP ${res.status})`, { status: res.status });
    }

    const srtText = await res.text();

    // Convert SRT to WebVTT format safely
    let vttText = srtText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!vttText.trim().toUpperCase().startsWith("WEBVTT")) {
      vttText = "WEBVTT\n\n" + vttText.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2");
    }
    return new NextResponse(vttText, {
      headers: {
        "Content-Type": "text/vtt; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=86400"
      }
    });
  } catch (err: any) {
    return new NextResponse(err.message || "Failed to process subtitle", { status: 500 });
  }
}
