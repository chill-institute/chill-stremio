import { expect, type Page } from "@playwright/test";

export async function audioFrequency(page: Page) {
  return page.evaluate(() => {
    const probe = Reflect.get(window, "hlsAudioProbe") as {
      analyser: AnalyserNode;
      context: AudioContext;
    };
    const samples = new Float32Array(probe.analyser.fftSize);
    probe.analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    let crossings = 0;
    for (let index = 1; index < samples.length; index++) {
      const previous = samples[index - 1] ?? 0;
      const current = samples[index] ?? 0;
      if (previous <= 0 && current > 0) crossings++;
      energy += current * current;
    }
    return {
      frequency: (crossings * probe.context.sampleRate) / samples.length,
      rms: Math.sqrt(energy / samples.length),
    };
  });
}

export async function attachAudioProbe(page: Page) {
  await page.locator("video").evaluate(async (video: HTMLVideoElement) => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 8192;
    context.createMediaElementSource(video).connect(analyser);
    analyser.connect(context.destination);
    Reflect.set(window, "hlsAudioProbe", { context, analyser });
    await context.resume();
  });
}

export async function verifyAudioFrequency(page: Page, frequency: number) {
  await expect
    .poll(
      async () => {
        const sample = await audioFrequency(page);
        return sample.rms > 0.01 && Math.abs(sample.frequency - frequency) < 15;
      },
      { timeout: 15000 },
    )
    .toBe(true);
  return audioFrequency(page);
}
