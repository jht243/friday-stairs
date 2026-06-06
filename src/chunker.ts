export interface Chunk {
  id: string;
  postSlug: string;
  postTitle: string;
  heading: string;
  text: string;
}

const MAX_CHARS = 4500;
const MIN_CHARS = 400;

export function chunkMarkdown(slug: string, title: string, body: string): Chunk[] {
  const chunks: Chunk[] = [];
  const sections = body.split(/\n(?=#{1,3} )/);
  let index = 0;

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed || trimmed.length < MIN_CHARS) continue;

    const headingMatch = trimmed.match(/^#{1,3} (.+)/);
    const heading = headingMatch?.[1] ?? title;

    if (trimmed.length <= MAX_CHARS) {
      chunks.push({
        id: `${slug}-${index++}`,
        postSlug: slug,
        postTitle: title,
        heading,
        text: trimmed,
      });
      continue;
    }

    const paragraphs = trimmed.split(/\n\n+/);
    let buffer = headingMatch ? `${headingMatch[0]}\n\n` : "";

    for (const para of paragraphs) {
      if ((buffer + para).length > MAX_CHARS && buffer.length >= MIN_CHARS) {
        chunks.push({
          id: `${slug}-${index++}`,
          postSlug: slug,
          postTitle: title,
          heading,
          text: buffer.trim(),
        });
        buffer = para;
      } else {
        buffer += (buffer ? "\n\n" : "") + para;
      }
    }

    if (buffer.trim().length >= MIN_CHARS) {
      chunks.push({
        id: `${slug}-${index++}`,
        postSlug: slug,
        postTitle: title,
        heading,
        text: buffer.trim(),
      });
    }
  }

  if (!chunks.length && body.trim().length >= MIN_CHARS) {
    chunks.push({
      id: `${slug}-0`,
      postSlug: slug,
      postTitle: title,
      heading: title,
      text: body.slice(0, MAX_CHARS),
    });
  }

  return chunks;
}
