import { processMarkdown } from "@ryanflorence/md";
import LRUCache from "lru-cache";
import parseYamlHeader from "gray-matter";
import invariant from "tiny-invariant";
import { getRepoContent } from "./repo-content.server";
import { getRepoTarballStream } from "./repo-tarball.server";
import { createTarFileProcessor } from "./tarball.server";
import { load as $ } from "cheerio";

export interface MenuDoc {
  attrs: {
    title: string;
    order?: number;
    new?: boolean;
    [key: string]: any;
  };
  children: MenuDoc[];
  filename: string;
  hasContent: boolean;
  slug: string;
}

export interface Doc extends Omit<MenuDoc, "hasContent"> {
  html: string;
  headings: { html: string | null; slug: string | undefined }[];
}

declare global {
  var menuCache: LRUCache<string, MenuDoc[]>;
  var docCache: LRUCache<string, Doc | undefined>;
}

let NO_CACHE = process.env.NO_CACHE;

global.menuCache ??= new LRUCache<string, MenuDoc[]>({
  // let menuCache = new LRUCache<string, MenuDoc[]>({
  max: 10,
  ttl: NO_CACHE ? 1 : 300000, // 5 minutes
  allowStale: !NO_CACHE,
  noDeleteOnFetchRejection: true,
  fetchMethod: async (cacheKey) => {
    console.log(`Fetching fresh menu: ${cacheKey}`);
    let [repo, ref] = cacheKey.split(":");
    let stream = await getRepoTarballStream(repo, ref);
    let menu = await getMenuFromStream(stream);
    return menu;
  },
});

export async function getMenu(
  repo: string,
  ref: string,
  lang: string
): Promise<MenuDoc[] | undefined> {
  return menuCache.fetch(`${repo}:${ref}`);
}

function parseAttrs(
  md: string,
  filename: string
): { content: string; attrs: Doc["attrs"] } {
  let { data, content } = parseYamlHeader(md);
  return {
    content,
    attrs: {
      title: filename,
      ...data,
    },
  };
}

/**
 * While we're using HTTP caching, we have this memory cache too so that
 * document requests and data request to the same document can do less work for
 * new versions. This makes our origin server very fast, but adding HTTP caching
 * let's have simpler and faster deployments with just one origin server, but
 * still distribute the documents across the CDN.
 */
global.docCache ??= new LRUCache<string, Doc | undefined>({
  // let docCache = new LRUCache<string, Doc | undefined>({
  max: 300,
  ttl: NO_CACHE ? 1 : 1000 * 60 * 5, // 5 minutes
  allowStale: !NO_CACHE,
  noDeleteOnFetchRejection: true,
  fetchMethod: async (key) => {
    console.log("Fetching fresh doc", key);
    let [repo, ref, slug] = key.split(":");
    let filename = `docs/${slug}.md`;
    let md = await getRepoContent(repo, ref, filename);
    if (md === null) return undefined;
    let { content, attrs } = parseAttrs(md, filename);
    let html = await processMarkdown(content);
    // sorry, cheerio is so much easier than using rehype stuff.
    let headings = createTableOfContentsFromHeadings(html);
    return { attrs, filename, html, slug, headings, children: [] };
  },
});

// create table of contents from h2 and h3 headings
function createTableOfContentsFromHeadings(html: string) {
  let $headings = $(html)("h2,h3");

  let headings = $headings.toArray().map((heading) => ({
    html: $(heading)("a").remove().end().children().html(),
    slug: heading.attributes.find((attr) => attr.name === "id")?.value,
  }));

  return headings;
}

export async function getDoc(
  repo: string,
  ref: string,
  slug: string
): Promise<Doc | undefined> {
  let key = `${repo}:${ref}:${slug}`;
  let doc = await docCache.fetch(key);
  return doc;
}

/**
 * Exported for unit tests
 */
export async function getMenuFromStream(stream: NodeJS.ReadableStream) {
  let docs: MenuDoc[] = [];
  let processFiles = createTarFileProcessor(stream);
  await processFiles(async ({ filename, content }) => {
    let { attrs, content: md } = parseAttrs(content, filename);
    let slug = makeSlug(filename);

    // don't need docs/index.md in the menu
    if (slug === "") return;

    // can have docs not in the menu
    if (attrs.hidden) return;

    docs.push({
      attrs,
      filename,
      slug: makeSlug(filename),
      hasContent: md.length > 0,
      children: [],
    });
  });

  // sort so we can process parents before children
  docs.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));

  // construct the hierarchy
  let tree: MenuDoc[] = [];
  let map = new Map<string, MenuDoc>();
  for (let doc of docs) {
    let { slug } = doc;

    let parentSlug = slug.substring(0, slug.lastIndexOf("/"));
    map.set(slug, doc);

    if (parentSlug) {
      let parent = map.get(parentSlug);
      invariant(parent, `Expected ${parentSlug} in tree`);
      parent.children.push(doc);
    } else {
      tree.push(doc);
    }
  }

  let sortDocs = (a: MenuDoc, b: MenuDoc) =>
    (a.attrs.order || Infinity) - (b.attrs.order || Infinity);

  // sort the parents and children
  tree.sort(sortDocs);
  for (let category of tree) {
    category.children.sort(sortDocs);
  }

  return tree;
}

/**
 * Removes the extension from markdown file names.
 */
function makeSlug(docName: string): string {
  // Could be as simple as `/^docs\//` but local development tarballs have more
  // path in front of "docs/", so grab any of that stuff too. Maybe there's a
  // way to control the basename of files when we make the local tarball but I
  // dunno how to do that right now.
  return docName
    .replace(/^(.+\/)?docs\//, "")
    .replace(/\.md$/, "")
    .replace(/index$/, "")
    .replace(/\/$/, "");
}
