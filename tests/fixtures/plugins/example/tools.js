// Sample plugin: shows the whole api surface. Plugins import nothing — zod, the
// page and the event store all arrive through the api object.
export async function register({ tools, z, open, selectors, events }) {
  tools.add('greeting', {
    description: 'Read the greeting from the example page.',
    inputSchema: {},
  }, async () => {
    const page = await open();
    const text = await page.locator(selectors.greeting).innerText();
    events.append({ type: 'read', what: 'greeting' });
    return { content: [{ type: 'text', text }] };
  });

  tools.add('echo', {
    description: 'Type text into the example box and read it back.',
    inputSchema: { text: z.string() },
  }, async ({ text }) => {
    const page = await open();
    await page.locator(selectors.box).fill(text);
    const back = await page.locator(selectors.box).inputValue();
    return { content: [{ type: 'text', text: back }] };
  });
}
