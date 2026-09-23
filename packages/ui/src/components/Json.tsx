/** Just enough JSON colour to read a config at a glance. */

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => (char === '&' ? '&amp;' : char === '<' ? '&lt;' : '&gt;'));
}

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

function highlight(json: string): string {
  return escapeHtml(json).replace(
    TOKEN,
    (match: string, key?: string, colon?: string, bool?: string, num?: string) => {
      if (key !== undefined) {
        return colon === undefined
          ? `<span class="s">${key}</span>`
          : `<span class="k">${key}</span>${colon}`;
      }
      if (bool !== undefined) return `<span class="b">${bool}</span>`;
      if (num !== undefined) return `<span class="n">${num}</span>`;
      return match;
    },
  );
}

export function Json({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2) ?? String(value);
  // Escaped first, so the only markup in here is the one this function wrote.
  return <pre className="json" dangerouslySetInnerHTML={{ __html: highlight(text) }} />;
}
