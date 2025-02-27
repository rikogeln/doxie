import * as fs from "fs";
import { Database } from "./database";
import { Rag } from "./rag";
import {
    BaseSource,
    EmbedderDocument,
    EmbedderDocumentSegment,
    FaqSource,
    FlarumDiscussion,
    FlarumSource,
    Logger,
    MarkdownZipSource,
    ProcessingJob,
    SitemapSource,
    VectorMetadata,
} from "../common/api";
import { Collection as MongoCollection, ObjectId, Document } from "mongodb";
import { assertNever, sleep } from "../utils/utils";
import { Embedder } from "./embedder";
import { ChromaClient, Collection, Metadata } from "chromadb";
import minimatch from "minimatch";
import xml2js from "xml2js";
import xpath from "xpath";
import { DOMParser } from "xmldom";
import { parseDocument } from "htmlparser2";
import domSerializer from "dom-serializer";
import { removeElement } from "domutils";
import * as JSZip from "jszip";
import { Tiktoken, getEncoding } from "js-tiktoken";
import { RecursiveCharacterTextSplitter } from "langchain/text_splitter";
import htmlToMarkdown from "@wcj/html-to-markdown";

async function recursiveSplit(doc: EmbedderDocument, chunkSize = 512, chunkOverlap = 0) {
    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize,
        chunkOverlap,
    });

    const segments: { text: string; tokenCount: number; embedding: number[] }[] = [];
    const textSplits = await splitter.splitText(doc.text);
    for (const split of textSplits) {
        const tokenCount = Embedder.tokenize(split).length;
        segments.push({ text: split, tokenCount, embedding: [] });
    }
    doc.segments = segments;
}

function countHashAtBeginning(line: string): number {
    const match = line.match(/^#+/);
    return match ? match[0].length : 0;
}

function normalizeHtml(html: string): string {
    const dom = parseDocument(html, {
        lowerCaseAttributeNames: false,
        recognizeSelfClosing: true,
    });

    // Function to recursively remove specific tags
    const removeTags = (elements: any[]) => {
        elements.forEach((element) => {
            if (element.type === "tag" && (element.name === "script" || element.name === "table" || element.name === "style")) {
                removeElement(element);
            } else if (element.children) {
                removeTags(element.children);
            }
        });
    };

    // Remove <script> and <table> tags
    removeTags(dom.children as any[]);

    return domSerializer(dom.children as any[]);
}

function cleanUpText(input: string): string {
    return (
        input
            .replace(/[^\S\r\n]+/g, " ")
            // Remove space after newlines
            .replace(/(\r?\n|\r) +/g, "\n")
            // Replace more than two consecutive newlines with two newlines
            .replace(/(\r?\n|\r){3,}/g, "\n\n")
            // Trim leading and trailing whitespace
            .trim()
    );
}

function extractDataWithXPath(normalizedHtml: string, xpathExpression: string) {
    const errorHandler = {
        warning: (w: any) => {}, // Suppress warnings
    };
    const doc = new DOMParser({ errorHandler }).parseFromString(normalizedHtml);
    let results: string[] = [];

    const result = xpath.select(xpathExpression, doc);
    if (!result) return;

    if (Array.isArray(result)) {
        result.forEach((node) => {
            if (typeof node === "object" && node.textContent) {
                results.push(node.textContent);
            }
        });
    } else if (typeof result === "object" && result.textContent) {
        results.push(result.textContent);
    } else if (typeof result === "string" || typeof result === "number" || typeof result === "boolean") {
        results.push(result.toString());
    }

    return results.map((str) => cleanUpText(str));
}

async function fetchWithRetry(url: string, tries = 5) {
    while (tries > 0) {
        try {
            const response = await fetch(url);
            return response;
        } catch (e) {}
        tries--;
    }
    throw new Error("Could not fetch " + url);
}

abstract class BaseProcessor<T extends BaseSource> {
    constructor(readonly processor: Processor, readonly source: T, readonly log: Logger, readonly shouldStop: () => Promise<boolean>) {}

    abstract process(): Promise<EmbedderDocument[]>;
}

class FaqProccessor extends BaseProcessor<FaqSource> {
    async process(): Promise<EmbedderDocument[]> {
        const documents: EmbedderDocument[] = [];
        await this.log("Processing " + this.source.faqs.length + " FAQ entries");
        for (const entry of this.source.faqs) {
            documents.push({
                uri: "faq://" + this.source._id + "/" + entry.id,
                text: entry.questions + "\n\n" + entry.answer,
                title: entry.questions,
                segments: [],
            });
        }
        const embedder = new Embedder(this.processor.openaiKey, this.log);
        await embedder.embedDocuments(documents, this.shouldStop, async (doc) => {
            const tokenCount = Embedder.tokenize(doc.text).length;
            if (tokenCount > 500) {
                throw new Error("Token count of FAQ entry '" + doc.title + "' > 500, make it smaller.");
            }
            doc.segments = [{ text: doc.text, tokenCount, embedding: [] }];
        });
        return documents;
    }
}

class FlarumProccessor extends BaseProcessor<FlarumSource> {
    async process(): Promise<EmbedderDocument[]> {
        this.log("Fetching Flarum dump, this may take a while");
        const response = await fetch(this.source.apiUrl);
        if (!response.ok) {
            throw new Error("Could not fetch Flarum forum dump from " + this.source.apiUrl + "\n" + (await response.text()));
        }
        const discussions: FlarumDiscussion[] = await response.json();
        this.log(discussions.length + " discussions");
        const docs: EmbedderDocument[] = [];
        let englishPosts = 0;
        let nonEnglishPosts = 0;
        let processed = 0;
        const staff = new Set<string>(this.source.staff.map((staff) => staff.toLowerCase()));
        const forumUrl = this.source.forumUrl.endsWith("/d/") ? this.source.forumUrl : this.source.forumUrl + "/d/";
        for (const discussion of discussions) {
            if (!discussion.posts) {
                this.log("No posts in discussion " + discussion.discussionId + " - " + discussion.title);
                continue;
            }
            const discussionUri = forumUrl + discussion.discussionId;
            let postId = 1;
            for (const post of discussion.posts) {
                if (post.detectedLang != "en") {
                    nonEnglishPosts++;
                    continue;
                } else {
                    englishPosts++;
                }
                if (staff.size > 0 && !staff.has(post.userName.toLowerCase())) {
                    continue;
                }
                const postUri = discussionUri + "/" + postId++;
                const tokenCount = Embedder.tokenize(post.content).length;
                const segments: EmbedderDocumentSegment[] = [];
                const t = discussion.title + "\n";
                // const content = await htmlToMarkdown({ html: discussion.title + "\n" + post.content });
                const content = discussion.title + "\n" + post.content;
                if (tokenCount > 500) {
                    const tmpDoc: EmbedderDocument = { uri: postUri, title: discussion.title, text: content, segments: [] };
                    await recursiveSplit(tmpDoc, 1024, 0);

                    for (const segment of tmpDoc.segments) {
                        segments.push(segment);
                    }
                } else {
                    segments.push({ text: content, tokenCount, embedding: [] });
                }
                docs.push({
                    title: discussion.title,
                    text: "",
                    uri: postUri,
                    segments,
                });
            }
            processed++;
            if (processed % 100 == 0) {
                this.log("Processed " + processed + "/" + discussions.length + " discussions");
            }
        }
        this.log("english: " + englishPosts + ", non-english: " + nonEnglishPosts);
        const embedder = new Embedder(this.processor.openaiKey, this.log);
        this.log("Writting docs to docker/data/" + this.source._id + ".json");
        fs.writeFileSync("docker/data/" + this.source._id + ".json", JSON.stringify(docs, null, 2), "utf-8");
        await embedder.embedDocuments(docs, this.shouldStop, async (doc) => {});
        return docs;
    }
}

class MarkdownZipProccessor extends BaseProcessor<MarkdownZipSource> {
    async process(): Promise<EmbedderDocument[]> {
        const filePath = "html/files/" + this.source.file;
        if (!fs.existsSync(filePath)) {
            throw new Error("Could not find file " + this.source.file);
        }

        const data = fs.readFileSync(filePath);
        const zip = await JSZip.loadAsync(data);
        const documents: EmbedderDocument[] = [];
        const tiktoken = getEncoding("cl100k_base");
        const files = Object.keys(zip.files);
        for (const relativePath of files) {
            if (relativePath.includes("__MACOSX/")) continue;
            if (relativePath.endsWith(".md")) {
                const file = zip.files[relativePath];
                const content = await file.async("string");
                // Extract URL and title
                const lines = content.replaceAll("\r", "").split("\n");
                const url = lines[0].trim();
                const title = lines[2].trim().replace("[", "").replace("]", "");

                // Remove the block until '[[]]'
                const endIndex = lines[3].startsWith("[[") && lines[3].trim().endsWith("]]") ? 3 : -1;
                if (endIndex == -1) throw new Error("Couldn't find header marker [[]] in " + relativePath + "\n" + lines.slice(0, 10).join("\n"));
                const modifiedContent = lines
                    .slice(endIndex + 1)
                    .join("\n")
                    .trim(); // +4 to remove '[[]]' itself

                const doc: EmbedderDocument = {
                    uri: url,
                    title,
                    text: modifiedContent,
                    segments: [],
                };
                documents.push(doc);
                await this.log("Processing " + relativePath + ", " + tiktoken.encode(modifiedContent).length + " tokens");
            }
        }

        const embedder = new Embedder(this.processor.openaiKey, this.log);
        await embedder.embedDocuments(documents, this.shouldStop, async (doc) => {
            const segments = doc.segments;
            const lines = doc.text.split("\n");
            const title: string[] = [];
            let currText = "";
            if (doc.uri == "http://esotericsoftware.com/spine-slots") {
                console.log("test");
            }
            while (lines.length > 0) {
                const line = lines.splice(0, 1)[0];
                const hashes = countHashAtBeginning(line.trim());
                if (hashes == 0) {
                    currText += line + "\n";
                } else {
                    if (currText.length > 0) {
                        const tokenCount = Embedder.tokenize(currText).length;
                        if (tokenCount > 500) {
                            const t = doc.title + "\n" + title.join("\n") + "\n";
                            currText = currText.replace(t, "").trim();
                            const tmpDoc: EmbedderDocument = { uri: doc.uri, title: doc.title, text: currText, segments: [] };
                            await recursiveSplit(tmpDoc, 1024, 0);

                            for (const segment of tmpDoc.segments) {
                                segment.text = (t + segment.text).trim();
                                segments.push(segment);
                            }
                        } else {
                            segments.push({ text: currText.trim(), tokenCount, embedding: [] });
                        }
                    }

                    if (hashes > title.length) {
                        title.push(line.trim());
                    } else {
                        if (title.length > 0) {
                            while (title.length > 0 && countHashAtBeginning(title[title.length - 1]) >= hashes) {
                                title.pop();
                            }
                        }
                        title.push(line.trim());
                    }
                    currText = doc.title + "\n" + title.join("\n") + "\n";
                }
            }

            if (currText.length > 0) {
                const tokenCount = Embedder.tokenize(currText).length;
                if (tokenCount > 500) {
                    const t = doc.title + "\n" + title.join("\n") + "\n";
                    currText = currText.replace(t, "").trim();
                    const tmpDoc: EmbedderDocument = { uri: doc.uri, title: doc.title, text: currText, segments: [] };
                    await recursiveSplit(tmpDoc, 1024, 0);

                    for (const segment of tmpDoc.segments) {
                        segment.text = (t + segment.text).trim();
                        segments.push(segment);
                    }
                } else {
                    segments.push({ text: currText.trim(), tokenCount, embedding: [] });
                }
            }
        });
        return documents;
    }
}

class SitemapProccessor extends BaseProcessor<SitemapSource> {
    async process(): Promise<EmbedderDocument[]> {
        const response = await fetch(this.source.url);
        if (!response) {
            throw new Error("Could not fetch sitemap from " + this.source.url);
        }
        const xml = await response.text();

        const parser = new xml2js.Parser();
        const xmlDoc = await parser.parseStringPromise(xml);

        const locElements = xmlDoc.urlset.url.map((urlObj: any) => urlObj.loc[0]);

        const included = this.source.included;
        const excluded = this.source.excluded;
        const urls: string[] = [];

        for (let url of locElements) {
            const isIncluded = included.length === 0 || included.some((pattern) => minimatch(url, pattern));
            const isNotExcluded = excluded.length === 0 || !excluded.some((pattern) => minimatch(url, pattern));

            if (isIncluded && isNotExcluded) {
                urls.push(url);
            }
        }

        this.log(`Scraping ${urls.length} urls from ${this.source.url}`);

        const documents: EmbedderDocument[] = [];
        const total = urls.length;
        while (urls.length > 0) {
            const batchUrls = urls.splice(0, 25);
            const responses = await Promise.all(batchUrls.map(async (url) => await fetchWithRetry(url)));
            const htmls = await Promise.all(
                responses.map((response) => {
                    if (!response) return undefined;
                    return response.text().catch((e) => {
                        this.log("Could not fetch html for " + response?.url);
                        return undefined;
                    });
                })
            );
            let i = 0;
            for (const html of htmls) {
                if (!html) continue;
                const normalizedHtml = normalizeHtml(html);
                const title = extractDataWithXPath(normalizedHtml, this.source.titlePath)?.join("\n") ?? "";
                let text = "";
                for (const contentPath of this.source.contentPaths) {
                    const content = extractDataWithXPath(normalizedHtml, contentPath);
                    const str = content?.join("\n") ?? "";
                    if (str.length > 0) text += str;
                }
                documents.push({
                    uri: batchUrls[i],
                    text: title + "\n" + text,
                    title,
                    segments: [],
                });
                i++;
            }
            this.log(`Scraped ${documents.length}/${total} sites`);
            if (await this.shouldStop()) throw new Error("Job stopped by user");
        }
        const embedder = new Embedder(this.processor.openaiKey, this.log);
        await embedder.embedDocuments(documents, this.shouldStop, (doc) => recursiveSplit(doc, 512, 0));
        return documents;
    }
}

class Processor {
    embedder: Embedder;
    chroma: ChromaClient;

    constructor(private jobs: MongoCollection<Document>, readonly database: Database, readonly openaiKey: string) {
        this.embedder = new Embedder(openaiKey, async (message: string) => console.log(message));
        this.chroma = new ChromaClient({ path: "http://chroma:8000" });
    }

    async getNextJob(): Promise<ProcessingJob | undefined> {
        let job = (await this.jobs.findOneAndUpdate(
            { state: "waiting" },
            { $set: { state: "running", startedAt: Date.now() } },
            { sort: { createdAt: 1 }, returnDocument: "after" }
        )) as ProcessingJob | null;
        if (!job) return undefined;
        job._id = (job as any)._id.toHexString();
        return job;
    }

    async updateJobLog(jobId: string, log: string): Promise<void> {
        await this.jobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { log } });
    }

    async checkJobStatus(jobId: string): Promise<ProcessingJob["state"]> {
        const job = (await this.jobs.findOne({ _id: new ObjectId(jobId) }, { projection: { state: 1 } })) as ProcessingJob | null;
        return job?.state ?? "stopped";
    }

    async finishJob(jobId: string, success: boolean): Promise<void> {
        const newState = success ? "succeeded" : "failed";
        await this.jobs.updateOne({ _id: new ObjectId(jobId) }, { $set: { state: newState, finishedAt: Date.now() } });
    }

    async log(job: ProcessingJob, message: string) {
        job.log += message + "\n";
        console.log(message);
        await this.updateJobLog(job._id!, job.log);
    }

    async deleteSourceDocs(collection: Collection, sourceId: string) {
        const limit = 500;
        let offset = 0;
        while (true) {
            const docIds = await collection.get({ where: { sourceId }, limit, offset, include: [] });
            if (!docIds.ids || docIds.ids.length == 0) break;
            await collection.delete({ ids: docIds.ids });
        }

        const docIds = await collection.get({ where: { sourceId }, limit, offset: 0 });
        if (docIds.ids?.length > 0) {
            console.error("Could not delete vectors for source " + sourceId);
        }
    }

    // Method to process the job
    async process(): Promise<void> {
        while (true) {
            try {
                const job = await this.getNextJob();
                if (job) {
                    try {
                        console.log("Got job " + JSON.stringify(job, null, 2));

                        const source = await this.database.getSource(job.sourceId);
                        console.log("Fetched source");

                        const docs: EmbedderDocument[] = [];
                        const logger: Logger = async (message: string) => await this.log(job, message);
                        const shouldStop = async () => (await this.checkJobStatus(job._id!)) == "stopped";
                        switch (source.type) {
                            case "faq": {
                                docs.push(...(await new FaqProccessor(this, source, logger, shouldStop).process()));
                                break;
                            }
                            case "flarum": {
                                docs.push(...(await new FlarumProccessor(this, source, logger, shouldStop).process()));
                                break;
                            }
                            case "sitemap": {
                                docs.push(...(await new SitemapProccessor(this, source, logger, shouldStop).process()));
                                break;
                            }
                            case "markdownzip": {
                                docs.push(...(await new MarkdownZipProccessor(this, source, logger, shouldStop).process()));
                                break;
                            }
                            default:
                                assertNever(source);
                        }

                        const collection = await this.chroma.getOrCreateCollection({
                            name: source._id!,
                            embeddingFunction: { generate: (texts) => this.embedder.embed(texts) },
                        });
                        logger("Deleting previous vectors for source " + source._id);
                        await this.deleteSourceDocs(collection, source._id!);
                        const ids = docs.flatMap((doc) => doc.segments.map((seg, index) => doc.uri + "|" + index));
                        const embeddings = docs.flatMap((doc) => doc.segments.map((seg) => seg.embedding));
                        const metadatas = docs.flatMap((doc) =>
                            doc.segments.map((seg, index) => {
                                const metadata: VectorMetadata = {
                                    sourceId: source._id!,
                                    docUri: doc.uri,
                                    docTitle: doc.title,
                                    index,
                                    tokenCount: seg.tokenCount,
                                };
                                return metadata as unknown as Metadata;
                            })
                        );
                        const vectorDocs = docs.flatMap((doc) =>
                            doc.segments.map((seg) => {
                                return seg.text;
                            })
                        );
                        let numProcessed = 0;
                        const total = ids.length;
                        while (ids.length > 0) {
                            const batchSize = 2000;
                            const batchIds = ids.splice(0, batchSize);
                            const batchEmbeddings = embeddings.splice(0, batchSize);
                            const batchMetadatas = metadatas.splice(0, batchSize);
                            const batchDocuments = vectorDocs.splice(0, batchSize);
                            await collection.upsert({
                                ids: batchIds,
                                embeddings: batchEmbeddings,
                                metadatas: batchMetadatas,
                                documents: batchDocuments,
                            });
                            numProcessed += batchIds.length;
                            logger(`Wrote ${numProcessed}/${total} segments to vector collection ${source._id}`);
                        }

                        await this.finishJob(job._id!, true);
                    } catch (e) {
                        let message = "";
                        if (e instanceof Error) {
                            message = e.stack ?? e.message;
                        } else {
                            message = "Error: " + JSON.stringify(e);
                        }
                        try {
                            await this.log(job, message);
                        } catch (e) {}
                        await this.finishJob(job._id!, false);
                    }
                }
            } catch (e) {
                console.error("Error fetching next job", e);
            } finally {
                await sleep(1000);
            }
        }
    }
}

const port = process.env.PORT ?? 3334;
const openaiKey = process.env.DOXIE_OPENAI_KEY;
if (!openaiKey) {
    console.error("Please specify the DOXIE_OPENAI_KEY env var");
    process.exit(-1);
}
const adminToken = process.env.DOXIE_ADMIN_TOKEN;
if (!adminToken) {
    console.error("Please specify the DOXIE_ADMIN_TOKEN env var");
    process.exit(-1);
}
const dbPassword = process.env.DOXIE_DB_PASSWORD;
if (!dbPassword) {
    console.error("Please specify the DOXIE_DB_PASSWORD env var");
    process.exit(-1);
}

(async () => {
    if (!fs.existsSync("docker/data")) {
        fs.mkdirSync("docker/data");
    }

    await Promise.all([Rag.waitForChroma(), Database.waitForMongo()]);
    await Database.jobs!.updateMany({ state: "running" }, { $set: { state: "stopped", finishedAt: Date.now() } });
    const db = new Database();
    const jobs = Database.jobs!;
    const processor = new Processor(jobs, db, openaiKey);
    processor.process();
})();
