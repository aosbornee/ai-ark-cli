/**
 * People export command — POST /people/export (async).
 * Submits export job, auto-polls until done, fetches and outputs results.
 * --no-wait returns the trackId immediately without polling.
 * --submissions lists pending/settled export jobs.
 * --track-ids resumes polling for existing export jobs.
 */

import { Command } from "commander";
import { createClient, AiArkApiError, pollUntilDone } from "../client/index.js";
import { formatOutput, readCsvFile, readStdin, pushToClay, persistResults, filterByProfile } from "../io/index.js";
import type { OutputFormat, Profile } from "../io/index.js";
import { buildAccountFilter, buildContactFilter } from "../filters.js";
import type { FilterOpts } from "../filters.js";
import { printReviewUrl, buildSearchUrl } from "../url-builder.js";
import type {
  ExportPeopleRequest,
  ExportJobResponse,
  ExportPeopleResultsResponse,
  ExportSubmissionsResponse,
  ApiEndpoint,
} from "../types/api.js";

/**
 * Split an array into chunks of the given size.
 */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * Post-filter: verify that the title keywords from --title appear in the
 * position_groups entry whose company domain matches one of the searched domains.
 * Catches the "side-gig" bug where a VP title is at a different company.
 */
function verifyTitleCompanyMatch(
  results: unknown[],
  titleKeywords: string[],
  searchedDomains: string[],
): unknown[] {
  if (titleKeywords.length === 0 || searchedDomains.length === 0) return results;

  const domainSet = new Set(searchedDomains.map((d) => d.toLowerCase().replace(/^www\./, "")));
  const titleLower = titleKeywords.map((t) => t.toLowerCase());

  const filtered: unknown[] = [];
  let dropped = 0;

  for (const result of results) {
    const person = result as any;
    const posGroups: any[] = person.position_groups || [];

    const matchingGroup = posGroups.find((pg: any) => {
      const companyUrl = pg.company?.url || "";
      const companyDomain = (pg.company?.domain || extractDomain(companyUrl) || "").toLowerCase().replace(/^www\./, "");
      return companyDomain && domainSet.has(companyDomain);
    });

    if (!matchingGroup) {
      filtered.push(result);
      continue;
    }

    const positions: any[] = matchingGroup.profile_positions || [];
    const hasMatch = positions.some((pos: any) => {
      const posTitle = (pos.title || "").toLowerCase();
      return titleLower.some((kw) => posTitle.includes(kw));
    });

    if (hasMatch) {
      filtered.push(result);
    } else {
      dropped++;
    }
  }

  if (dropped > 0) {
    process.stderr.write(`Title-company verification: filtered out ${dropped} contact(s) with mismatched titles\n`);
  }

  return filtered;
}

function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname;
  } catch {
    return "";
  }
}

/**
 * Fetch all results for a settled export job, paginating through all pages.
 */
async function fetchExportResults(
  client: ReturnType<typeof createClient>,
  trackId: string,
): Promise<unknown[]> {
  const allResults: unknown[] = [];
  let page = 0;
  const pageSize = 100;

  while (true) {
    const resultsEndpoint: ApiEndpoint = `/people/export/${trackId}/inquiries`;
    const results = await client.get<ExportPeopleResultsResponse>(
      `${resultsEndpoint}?page=${page}&size=${pageSize}` as ApiEndpoint,
    );
    allResults.push(...results.content);
    if (results.last || results.content.length === 0) break;
    page++;
  }

  return allResults;
}

export function peopleExportCommand(): Command {
  return new Command("export")
    .description("Bulk export with email discovery")
    // Account (company) filters
    .option("--domain <domains...>", "Filter by company domain")
    .option("--company <names...>", "Filter by company name")
    .option("--industry <industries...>", "Filter by company industry")
    .option("--technology <techs...>", "Filter by company technology")
    .option("--employees <range>", "Employee range (e.g. 50-200)")
    .option("--funding-type <types...>", "Filter by funding round (e.g. SERIES_A SERIES_B)")
    .option("--geo <lat,lng,radius>", "GeoLocation filter (e.g. 40.71,-74.00,50km)")
    .option("--geo-unit <unit>", "Geo radius unit: km or mi", "km")
    // Contact filters
    .option("--name <names...>", "Filter by person full name")
    .option("--title <titles...>", "Filter by current title")
    .option("--previous-title <titles...>", "Filter by previous title")
    .option("--seniority <levels...>", "Filter by seniority")
    .option("--department <depts...>", "Filter by department")
    .option("--location <locations...>", "Filter by person location")
    .option("--skills <skills...>", "Filter by skills")
    .option("--keyword <terms...>", "Search across headline, summary, organization")
    .option("--badge <badges...>", "Filter by profile badge (PAID_SOCIAL_MEMBERS, HIRING, OPEN_TO_WORK)")
    .option("--job-duration-min <months>", "Minimum months in current role")
    .option("--job-duration-max <months>", "Maximum months in current role")
    // Social reach (LinkedIn only)
    .option("--min-followers <count>", "Min LinkedIn followers (e.g. 5000 or 5k)")
    .option("--max-followers <count>", "Max LinkedIn followers")
    .option("--followers <bands>", "Follower bands, comma-separated (e.g. 1k-2k,5k+,<500)")
    .option("--min-connections <count>", "Min LinkedIn connections (e.g. 500)")
    .option("--max-connections <count>", "Max LinkedIn connections")
    .option("--connections <bands>", "Connection bands, comma-separated (e.g. 500-1k,3k+)")
    // Exclude filters
    .option("--exclude-domain <domains...>", "Exclude company domains")
    .option("--exclude-domain-file <file>", "Exclude domains from CSV file")
    .option("--exclude-domain-col <name>", "Column name in exclude CSV", "domain")
    .option("--exclude-company <names...>", "Exclude company names")
    .option("--exclude-industry <industries...>", "Exclude industries")
    .option("--exclude-title <titles...>", "Exclude job titles")
    .option("--exclude-seniority <levels...>", "Exclude seniority levels")
    .option("--exclude-department <depts...>", "Exclude departments")
    .option("--exclude-location <locs...>", "Exclude locations")
    .option("--exclude-badge <badges...>", "Exclude profile badges")
    .option("--exclude-name <names...>", "Exclude person names")
    // Batch input
    .option("--input <file>", "CSV file for batch domain input")
    .option("--domain-col <name>", "Column name for domain in CSV", "domain")
    // Global
    .option("--match-mode <mode>", "Search mode: SMART, WORD, STRICT", "SMART")
    .option("--size <number>", "Max people to export (1-10000)", "100")
    .option("--format <type>", "Output format: json, csv, table", "json")
    .option("--profile <name>", "Output shape: outbound (Tier 1 fields, default) or raw (full API response)", "outbound")
    .option("--clay-table <id>", "Push results to a Clay table")
    .option("--output <file>", "Write results to this exact path instead of ~/.ai-ark/results/")
    .option("--no-save", "Skip auto-save to ~/.ai-ark/results/")
    .option("--dry-run", "Print review URL + filter payload without submitting export")
    .option("--no-review-url", "Suppress the review URL printed to stderr")
    .option("--no-wait", "Return trackId immediately without polling")
    .option("--chunk-size <number>", "Domains per API call when batching (default: 300)", "300")
    .option("--verify-title-match", "Post-filter: drop contacts whose title doesn't match at the searched company")
    .option("--submissions", "List pending and settled export jobs instead of running an export")
    .option("--track-ids <ids>", "Resume polling for existing export jobs (comma-separated trackIds)")
    .action(async (opts) => {
      try {
        const client = createClient();
        const format = opts.format as OutputFormat;
        const filterOpts = opts as FilterOpts;
        filterOpts.matchMode = opts.matchMode;
        filterOpts.excludeContactName = opts.excludeName;
        filterOpts.contactKeyword = opts.keyword;
        filterOpts.keyword = undefined;

        // Validate profile early
        const profile = opts.profile as Profile;
        if (profile !== "outbound" && profile !== "raw") {
          console.error(`Error: --profile must be "outbound" or "raw" (got "${profile}")`);
          process.exit(1);
        }

        // ---------------------------------------------------------------
        // Feature 2: --submissions — list pending/settled export jobs
        // ---------------------------------------------------------------
        if (opts.submissions) {
          process.stderr.write("Fetching export submissions...\n");

          const pendingEndpoint: ApiEndpoint = `/people/export/submissions?state=PENDING&size=100`;
          const settledEndpoint: ApiEndpoint = `/people/export/submissions?state=SETTLED&size=100`;

          const [pending, settled] = await Promise.all([
            client.get<ExportSubmissionsResponse>(pendingEndpoint),
            client.get<ExportSubmissionsResponse>(settledEndpoint),
          ]);

          const allSubmissions = [
            ...(pending.content || []),
            ...(settled.content || []),
          ];

          // Display summary to stderr
          process.stderr.write(`\nPENDING (${(pending.content || []).length}):\n`);
          for (const sub of (pending.content || [])) {
            process.stderr.write(`  ${sub.trackId}  state=${sub.state}  size=${sub.requestSize}  submitted=${sub.submittedDate}\n`);
          }

          process.stderr.write(`\nSETTLED (${(settled.content || []).length}):\n`);
          for (const sub of (settled.content || [])) {
            process.stderr.write(`  ${sub.trackId}  state=${sub.state}  size=${sub.requestSize}  submitted=${sub.submittedDate}  done=${sub.doneDate || "n/a"}  refunded=${sub.fullyRefunded}\n`);
          }

          // Output raw data to stdout as JSON
          formatOutput(allSubmissions, format);
          return;
        }

        // ---------------------------------------------------------------
        // Feature 3: --track-ids — resume polling for existing exports
        // ---------------------------------------------------------------
        if (opts.trackIds) {
          const trackIds = opts.trackIds.split(",").map((id: string) => id.trim()).filter(Boolean);
          if (trackIds.length === 0) {
            console.error("Error: --track-ids requires at least one trackId");
            process.exit(1);
          }

          process.stderr.write(`Resuming ${trackIds.length} export job(s)...\n`);

          const allResults: unknown[] = [];
          const seenIds = new Set<string>();

          for (const trackId of trackIds) {
            process.stderr.write(`\nPolling trackId: ${trackId}\n`);
            const statsEndpoint: ApiEndpoint = `/people/export/${trackId}/inquiries/statistics`;
            const poll = await pollUntilDone(client, statsEndpoint);

            if (poll.state === "FAILED") {
              process.stderr.write(`  Export ${trackId} failed after ${poll.elapsed}s\n`);
              continue;
            }

            process.stderr.write(`  Fetching ${poll.found} results...\n`);
            const results = await fetchExportResults(client, trackId);
            allResults.push(...results);
          }

          // Deduplicate by person id
          const deduplicated: unknown[] = [];
          for (const result of allResults) {
            const person = result as any;
            const personId = person.id || person.identifier;
            if (personId && seenIds.has(personId)) continue;
            if (personId) seenIds.add(personId);
            deduplicated.push(result);
          }

          if (deduplicated.length < allResults.length) {
            process.stderr.write(`Deduplicated: ${allResults.length} -> ${deduplicated.length} unique contacts\n`);
          }

          const filtered = filterByProfile(deduplicated, "person", profile);
          persistResults({
            data: filtered,
            command: "people-export",
            output: opts.output,
            noSave: opts.save === false,
          });
          if (opts.clayTable) {
            pushToClay(opts.clayTable, filtered as unknown[]);
          }
          formatOutput(filtered, format);
          return;
        }

        // ---------------------------------------------------------------
        // Resolve batch domains from --input / stdin
        // ---------------------------------------------------------------
        let domains: string[] = opts.domain || [];

        if (opts.input) {
          const records = readCsvFile(opts.input);
          const col = opts.domainCol;
          const csvDomains = records.map((r: Record<string, string>) => r[col]).filter(Boolean);
          if (csvDomains.length === 0) {
            console.error(`Error: No values found in column "${col}" of ${opts.input}`);
            process.exit(1);
          }
          domains = [...domains, ...csvDomains];
        } else if (!process.stdin.isTTY) {
          const records = await readStdin();
          const stdinDomains = records.map((r) => r.domain || r.value).filter(Boolean);
          domains = [...domains, ...stdinDomains];
        }

        // Resolve domains onto filterOpts for review URL
        if (domains.length > 0) {
          filterOpts.domain = domains;
        }

        if (opts.reviewUrl !== false) {
          printReviewUrl(filterOpts, "people");
        }

        // ---------------------------------------------------------------
        // Dry-run
        // ---------------------------------------------------------------
        if (opts.dryRun) {
          const body: ExportPeopleRequest = {
            page: 0,
            size: parseInt(opts.size, 10),
            webhook: "https://example.com/webhook",
          };
          const account = buildAccountFilter(filterOpts, "people");
          if (account) body.account = account;
          const contact = buildContactFilter(filterOpts);
          if (contact) body.contact = contact;

          process.stderr.write("Dry run — no export submitted. Payload:\n");
          formatOutput(
            { reviewUrl: buildSearchUrl(filterOpts, "people"), request: body },
            format,
          );
          return;
        }

        const chunkSize = parseInt(opts.chunkSize, 10) || 300;

        // ---------------------------------------------------------------
        // Chunked export: batch domains into groups
        // ---------------------------------------------------------------
        if (domains.length > 1) {
          const chunks = chunkArray(domains, chunkSize);
          process.stderr.write(`Exporting ${domains.length} domains in ${chunks.length} chunk(s) of up to ${chunkSize}...\n`);

          const allTrackIds: string[] = [];
          const allResults: unknown[] = [];
          const seenIds = new Set<string>();

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            process.stderr.write(`\nChunk ${i + 1}/${chunks.length}: ${chunk.length} domains\n`);

            const chunkOpts = { ...filterOpts, domain: chunk };
            const body: ExportPeopleRequest = {
              page: 0,
              size: parseInt(opts.size, 10),
              webhook: "https://example.com/webhook",
            };
            const account = buildAccountFilter(chunkOpts, "people");
            if (account) body.account = account;
            const contact = buildContactFilter(chunkOpts);
            if (contact) body.contact = contact;

            const job = await client.post<ExportJobResponse>("/people/export", body);
            allTrackIds.push(job.trackId);

            if (!opts.wait) {
              process.stderr.write(`  trackId: ${job.trackId}\n`);
              continue;
            }

            // Poll until done
            process.stderr.write(`  Export started (trackId: ${job.trackId})\n`);
            const statsEndpoint: ApiEndpoint = `/people/export/${job.trackId}/inquiries/statistics`;
            const poll = await pollUntilDone(client, statsEndpoint);

            if (poll.state === "FAILED") {
              process.stderr.write(`  Chunk ${i + 1} failed after ${poll.elapsed}s\n`);
              continue;
            }

            process.stderr.write(`  Fetching ${poll.found} results...\n`);
            const results = await fetchExportResults(client, job.trackId);
            allResults.push(...results);
          }

          // --no-wait: return all trackIds
          if (!opts.wait) {
            const noWaitData = allTrackIds.map((id) => ({ trackId: id }));
            persistResults({
              data: noWaitData,
              command: "people-export",
              output: opts.output,
              noSave: opts.save === false,
            });
            formatOutput(noWaitData, format);
            return;
          }

          // Deduplicate by person id
          const deduplicated: unknown[] = [];
          for (const result of allResults) {
            const person = result as any;
            const personId = person.id || person.identifier;
            if (personId && seenIds.has(personId)) continue;
            if (personId) seenIds.add(personId);
            deduplicated.push(result);
          }

          if (deduplicated.length < allResults.length) {
            process.stderr.write(`Deduplicated: ${allResults.length} -> ${deduplicated.length} unique contacts\n`);
          }

          // Apply title-company verification post-filter if requested
          const verified = opts.verifyTitleMatch
            ? verifyTitleCompanyMatch(deduplicated, opts.title || [], domains)
            : deduplicated;

          const filtered = filterByProfile(verified, "person", profile);
          persistResults({
            data: filtered,
            command: "people-export",
            output: opts.output,
            noSave: opts.save === false,
          });
          if (opts.clayTable) {
            pushToClay(opts.clayTable, filtered as unknown[]);
          }
          formatOutput(filtered, format);
          return;
        }

        // ---------------------------------------------------------------
        // Single export (original flow)
        // ---------------------------------------------------------------

        // webhook is required by the API even though we poll via statistics endpoint
        const body: ExportPeopleRequest = {
          page: 0,
          size: parseInt(opts.size, 10),
          webhook: "https://example.com/webhook",
        };

        const account = buildAccountFilter(filterOpts, "people");
        if (account) body.account = account;

        const contact = buildContactFilter(filterOpts);
        if (contact) body.contact = contact;

        // Submit the export job
        const job = await client.post<ExportJobResponse>("/people/export", body);

        if (!opts.wait) {
          const noWaitData = { trackId: job.trackId, state: job.state };
          persistResults({
            data: noWaitData,
            command: "people-export",
            output: opts.output,
            noSave: opts.save === false,
          });
          formatOutput(noWaitData, format);
          return;
        }

        // Poll until done
        process.stderr.write(`Export started (trackId: ${job.trackId})\n`);
        const statsEndpoint: ApiEndpoint = `/people/export/${job.trackId}/inquiries/statistics`;
        const poll = await pollUntilDone(client, statsEndpoint);

        if (poll.state === "FAILED") {
          console.error(`Export failed after ${poll.elapsed}s`);
          process.exit(1);
        }

        // Fetch results (paginate through all)
        process.stderr.write(`Fetching ${poll.found} results...\n`);
        const allResults = await fetchExportResults(client, job.trackId);

        // Apply title-company verification post-filter if requested
        const verified = opts.verifyTitleMatch
          ? verifyTitleCompanyMatch(allResults, opts.title || [], domains)
          : allResults;

        const filtered = filterByProfile(verified, "person", profile);
        persistResults({
          data: filtered,
          command: "people-export",
          output: opts.output,
          noSave: opts.save === false,
        });
        if (opts.clayTable) {
          pushToClay(opts.clayTable, filtered as unknown[]);
        }
        formatOutput(filtered, format);
      } catch (error) {
        if (error instanceof AiArkApiError) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        if (error instanceof Error) {
          console.error(`Error: ${error.message}`);
          process.exit(1);
        }
        console.error("Error: Unknown error occurred");
        process.exit(1);
      }
    });
}
