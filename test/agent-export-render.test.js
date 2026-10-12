/* Optional real renderer check. Install ffmpeg/ffprobe and Chrome/Edge to run;
   the ordinary suite also tests the protocol without any of those programs. */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { findBrowser } = require("../export-jobs");
const { makeDataDir, startServer, startMcp } = require("./helpers");

const available = (name) => spawnSync(name, ["-version"], { stdio: "ignore" }).status === 0;
const skip = !findBrowser() || !available("ffmpeg") || !available("ffprobe");

test("headless agent export renders images, slow-motion video, text, crop, audio and IN/OUT with the Fast compositor",
  { skip, timeout: 90_000 }, async (t) => {
    const doc = { name: "Agent Render", revision: 7, panSchema: 1,
      width: 160, height: 90, fps: 30, background: "#ff0000",
      exportFrame: { x: 40, y: 0, w: 80, h: 90 }, inPoint: 0.2, outPoint: 0.8,
      media: [{ id: "m_v", kind: "video", src: "/media/input.mp4", name: "input.mp4", duration: 1, width: 160, height: 90 },
        { id: "m_i", kind: "image", src: "/media/card.png", name: "card.png" },
        { id: "m_a", kind: "audio", src: "/media/tone.wav", name: "tone.wav", duration: 1 }],
      clips: [{ id: "c_i", kind: "image", mediaId: "m_i", track: "V1", start: 0, in: 0, duration: 1 },
        { id: "c_v", kind: "video", mediaId: "m_v", track: "V2", start: 0, in: 0, duration: 1, props: { speed: 0.25, scale: 0.5, volume: 0 } },
        { id: "c_t", kind: "text", track: "V3", start: 0, in: 0, duration: 1, props: { text: "FABLE", font: "Anton", fontSize: 20, color: "#ffffff" } },
        { id: "c_a", kind: "audio", mediaId: "m_a", track: "A1", start: 0, in: 0, duration: 1 }] };
    const dir = makeDataDir(t, doc);
    fs.mkdirSync(path.join(dir, "media"));
    for (const [input, output, args] of [
      ["testsrc2=size=160x90:rate=25:duration=1", "input.mp4", ["-c:v", "libx264", "-pix_fmt", "yuv420p"]],
      ["sine=frequency=440:duration=1", "tone.wav", []],
      ["color=c=red:size=160x90", "card.png", ["-frames:v", "1"]],
    ]) {
      const r = spawnSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", input, ...args, path.join(dir, "media", output)], { encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
    }
    const { port } = await startServer(t, dir, { FABLECUT_NO_FS_WATCH: "1" });
    const mcp = startMcp(t, dir, { FABLECUT_PORT: String(port) });
    await mcp.request("initialize", { protocolVersion: "2025-11-25" });
    const r = await mcp.request("tools/call", { name: "fablecut_export", arguments: {
      where: "headless", range: "in-out", profile: "draft", timeout: 60,
    } }, { timeout: 75_000 });
    const result = r.result.content[0].text;
    assert.equal(r.result.isError, undefined, result);
    assert.match(result, /done →/, result);
    const file = path.join(dir, "exports", "Agent Render.mp4");
    const probe = spawnSync("ffprobe", ["-v", "error", "-show_streams", "-of", "json", file], { encoding: "utf8" });
    assert.equal(probe.status, 0, probe.stderr);
    const streams = JSON.parse(probe.stdout).streams, video = streams.find((s) => s.codec_type === "video");
    assert.equal(video.width, 80);
    assert.equal(video.height, 90);
    assert.equal(Number(video.nb_frames), 18);
    assert.equal(video.color_space, "bt709");
    assert.ok(streams.some((s) => s.codec_type === "audio"), "offline audio mix is muxed");
    const frame = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], { maxBuffer: 1_000_000 });
    assert.equal(frame.status, 0, frame.stderr.toString());
    assert.ok(frame.stdout[0] > 230 && frame.stdout[1] < 15 && frame.stdout[2] < 15, "crop corner preserves the canvas red background");
    let whites = 0;
    for (let i = 0; i < frame.stdout.length; i += 3)
      if (frame.stdout[i] > 220 && frame.stdout[i + 1] > 220 && frame.stdout[i + 2] > 220) whites++;
    assert.ok(whites > 20, "title is composited into the video");
    assert.ok(fs.statSync(file).size > 1000);
  });
