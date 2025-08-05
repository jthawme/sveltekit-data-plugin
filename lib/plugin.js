import fm from "front-matter";
import path from "path";
import fs from "fs/promises";

const REGEX = {
  IMAGE: /^\S*(jpg|png|webp|avif|jpeg)$/,
  YOUTUBE: /^(https?\:\/\/)?((www\.)?youtube\.com|youtu\.be)\/.+$/,
};

/**
 *
 * @param {string} type
 * @param {string} url
 * @returns {Promise<{src: string, width: number, height: number, type: string}>}
 */
function oembed(type, url) {
  switch (type) {
    case "youtube":
      return fetch(`https://youtube.com/oembed?url=${url}&format=json`)
        .then((resp) => resp.json())
        .catch(() => {
          return {
            src: url,
            width: 1280,
            height: 720,
            type: "error",
          };
        });
    default:
      return Promise.resolve({
        src: url,
        width: 1280,
        height: 720,
        type: "error",
      });
  }
}

/**
 *
 * @param {string} src
 * @param {string} base
 * @returns
 */
function stampURL(src, base) {
  return `${path.resolve(base, src)}?enhanced`;
}

/**
 *
 * @param {string} str
 * @returns {object}
 */
function parseObject(str) {
  const updated = str
    .replaceAll(/{(\n\s*)?/gm, '{"')
    .replaceAll(":", '":')
    .replaceAll(/,(\n\s*)?([^ ])/g, ',"$2');
  try {
    return JSON.parse(updated);
  } catch {
    throw new Error(`Failed parsing string to object: ${str}`);
  }
}

/**
 *
 * @param {*} opts
 * @param {*} obj
 * @param {{ depth?: number, relative?: string, base?: string }} info
 * @returns {Promise<any>}
 */
async function convert(opts, obj, { base, relative, depth = 1 } = {}) {
  if (typeof obj !== "object") {
    // Image strings
    if (typeof obj === "string" && REGEX.IMAGE.test(obj)) {
      try {
        const img = await opts.imagetools_plugin.load.call(
          opts.plugin_context,
          stampURL(obj, obj.startsWith("./") && relative ? relative : base)
        );

        return parseObject(img.slice("export default".length, -1));
      } catch (e) {
        return {
          src: null,
        };
      }
    }

    // Youtube videos
    if (typeof obj === "string" && REGEX.YOUTUBE.test(obj)) {
      const oembedData = await oembed("youtube", obj);

      return { ...oembedData };
    }

    // Related md files
    if (typeof obj === "string" && /^\S*(.md)$/.test(obj) && depth === 1) {
      try {
        const markdownFile = path.resolve(base, obj);
        const relativeFolder = path.basename(markdownFile);
        const contents = await fs.readFile(markdownFile, "utf-8");
        const data = fm(contents);
        const attributes = await convert(opts, data.attributes, {
          base,
          relative: relativeFolder,
          depth: depth + 1,
        });

        return {
          attributes: {
            ...attributes,
            id: path.basename(obj),
          },
          body: data.body,
        };
      } catch {
        return obj;
      }
    }

    return obj;
  }

  const entries = await Promise.all(
    Object.entries(obj).map(async ([key, value]) => {
      if (Array.isArray(value)) {
        const values = await Promise.all(
          value.map((item) => convert(opts, item, { base, depth, relative }))
        );

        return [key, values];
      }

      const v = await convert(opts, value, { base, depth, relative });
      return [key, v];
    })
  );

  return entries.reduce((dict, curr) => {
    return {
      ...dict,
      [curr[0]]: curr[1],
    };
  }, {});
}

/**
 *
 * @param {import('vite').Plugin} imagetools_plugin
 * @param {{base?: string}} [opts]
 *
 * @returns {import('vite').Plugin}
 */
function importDataPlugin(imagetools_plugin, { base = "./src/data" } = {}) {
  const opts = {
    /** @type {import('rollup').PluginContext | null} */
    plugin_context: null,

    /** @type {import('vite').ResolvedConfig | null} */
    vite_config: null,
    imagetools_plugin,
    base,
  };

  return {
    name: "import-data",
    enforce: "pre",

    configResolved(config) {
      opts.vite_config = config;
    },
    buildStart() {
      opts.plugin_context = this;
    },

    async transform(src, id) {
      if (/\.(md)$/.test(id)) {
        const base = path.resolve(opts.vite_config?.root ?? "", opts.base);

        const d = fm(src);
        const attributes = await convert(opts, d.attributes, base);

        return `
${Object.entries(attributes)
  .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};`)
  .join("\n")}
export const body = ${JSON.stringify(d.body)};`;
      }
    },
  };
}
/**
 *
 * @param {import('vite').Plugin[]} imagePlugins
 * @returns {import('vite').Plugin[]}
 */
export default function plugin(imagePlugins) {
  const enhancedImagesPlugin = imagePlugins.find(
    (item) => item.name === "imagetools"
  );

  if (!enhancedImagesPlugin) {
    throw new Error("Cannot find enhanced image plugin");
  }

  return [importDataPlugin(enhancedImagesPlugin), ...imagePlugins];
}
