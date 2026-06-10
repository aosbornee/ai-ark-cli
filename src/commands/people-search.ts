/**
 * People search command — POST /people with account + contact filter flags.
 * Supports CSV/stdin input for batch processing and multi-format output.
 */

import { Command } from "commander";
import { createClient, AiArkApiError } from "../client/index.js";
import { formatOutput, readCsvFile, readStdin, pushToClay, persistResults, filterByProfile } from "../io/index.js";
import type { OutputFormat, Profile } from "../io/index.js";
import { buildAccountFilter, buildContactFilter } from "../filters.js";
import type { FilterOpts } from "../filters.js";
import { printReviewUrl, buildSearchUrl } from "../url-builder.js";
import type {
  PeopleSearchRequest,
  PeopleSearchResponse,
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

    // Find the position group whose company domain matches one of the searched domains
    const matchingGroup = posGroups.find((pg: any) => {
      const companyUrl = pg.company?.url || "";
      // Extract domain from LinkedIn URL or direct domain field
      const companyDomain = (pg.company?.domain || extractDomain(companyUrl) || "").toLowerCase().replace(/^www\./, "");
      return companyDomain && domainSet.has(companyDomain);
    });

    if (!matchingGroup) {
      // No matching company found in position_groups -- keep the result
      // (could be a name-based search with no domain filter)
      filtered.push(result);
      continue;
    }

    // Check if any title keyword appears in the matching group's positions
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

/**
 * Extract a domain from a URL string.
 */
function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname;
  } catch {
    return "";
  }
}

export function peopleSearchCommand(): Command {
  return new Command("search")
    .description("Search 400M+ people profiles")
    // Account (company) filters
    .option("--domain <domains...>", "Filter by company domain")
    .option("--company <names...>", "Filter by company name")
    .option("--industry <industries...>", "Filter by company industry")
    .option("--technology <techs...>", "Filter by technology stack")
    .option("--employees <range>", "Employee range (e.g. 50-200)")
    .option("--funding-type <types...>", "Filter by funding round (e.g. SERIES_A SERIES_B)")
    .option("--geo <lat,lng,radius>", "GeoLocation filter (e.g. 40.71,-74.00,50km)")
    .option("--geo-unit <unit>", "Geo radius unit: km or mi", "km")
    // Contact filters
    .option("--name <names...>", "Filter by person full name")
    .option("--title <titles...>", "Filter by current title")
    .option("--previous-title <titles...>", "Filter by previous title")
    .option("--seniority <levels...>", "Filter by seniority (founder, c_suite, vp, director, head, manager, senior)")
    .option("--department <depts...>", "Filter by department")
    .option("--location <locations...>", "Filter by person location")
    .option("--skills <skills...>", "Filter by skills")
    .option("--linkedin <urls...>", "Filter by LinkedIn URL")
    .option("--keyword <terms...>", "Search across headline, summary, organization")
    .option("--badge <badges...>", "Filter by profile badge (PAID_SOCIAL_MEMBERS, HIRING, OPEN_TO_WORK, CREATOR, INFLUENCER)")
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
    // Global
    .option("--match-mode <mode>", "Search mode: SMART, WORD, STRICT", "SMART")
    .option("--page <number>", "Page number (0-based)", "0")
    .option("--size <number>", "Results per page (1-100)", "10")
    .option("--format <type>", "Output format: json, csv, table", "json")
    .option("--profile <name>", "Output shape: outbound (Tier 1 fields, default) or raw (full API response)", "outbound")
    .option("--input <file>", "CSV file for batch input")
    .option("--domain-col <name>", "Column name for domain in CSV", "domain")
    .option("--clay-table <id>", "Push results to a Clay table")
    .option("--output <file>", "Write results to this exact path instead of ~/.ai-ark/results/")
    .option("--no-save", "Skip auto-save to ~/.ai-ark/results/")
    .option("--dry-run", "Print review URL + filter payload without calling the API")
    .option("--no-review-url", "Suppress the review URL printed to stderr")
    .option("--chunk-size <number>", "Domains per API call when batching (default: 300)", "300")
    .option("--verify-title-match", "Post-filter: drop contacts whose title doesn't match at the searched company")
    .action(async (opts) => {
      try {
        const client = createClient();
        const format = opts.format as OutputFormat;
        const filterOpts = opts as FilterOpts;
        filterOpts.matchMode = opts.matchMode;
        // Map --exclude-name to excludeContactName (people cmd: --name is person, not company)
        filterOpts.excludeContactName = opts.excludeName;
        // keyword in people cmd goes to contact.keyword
        filterOpts.contactKeyword = opts.keyword;
        // Don't let keyword also set account.keyword
        const savedKeyword = filterOpts.keyword;
        filterOpts.keyword = undefined;

        // Determine input source
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

        // Resolve domains onto filterOpts so the URL reflects the real search.
        if (domains.length > 0) {
          filterOpts.domain = domains;
        }

        // Emit review URL (unless suppressed).
        if (opts.reviewUrl !== false) {
          printReviewUrl(filterOpts, "people");
        }

        // Dry-run: print URL + payload, skip the API call entirely.
        if (opts.dryRun) {
          const body: PeopleSearchRequest = {
            page: parseInt(opts.page, 10),
            size: parseInt(opts.size, 10),
          };
          const account = buildAccountFilter(filterOpts, "people");
          if (account) body.account = account;
          const contact = buildContactFilter(filterOpts);
          if (contact) body.contact = contact;
          process.stderr.write("Dry run — no API call made. Payload:\n");
          formatOutput({ reviewUrl: buildSearchUrl(filterOpts, "people"), request: body }, format);
          filterOpts.keyword = savedKeyword;
          return;
        }

        // Validate profile
        const profile = opts.profile as Profile;
        if (profile !== "outbound" && profile !== "raw") {
          console.error(`Error: --profile must be "outbound" or "raw" (got "${profile}")`);
          process.exit(1);
        }

        const chunkSize = parseInt(opts.chunkSize, 10) || 300;

        // If we have batch domains, chunk them and search
        if (domains.length > 1) {
          const chunks = chunkArray(domains, chunkSize);
          const allResults: unknown[] = [];

          process.stderr.write(`Searching ${domains.length} domains in ${chunks.length} chunk(s) of up to ${chunkSize}...\n`);

          for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            process.stderr.write(`  Chunk ${i + 1}/${chunks.length}: ${chunk.length} domains\n`);

            const batchOpts = { ...filterOpts, domain: chunk };
            const body: PeopleSearchRequest = {
              page: parseInt(opts.page, 10),
              size: parseInt(opts.size, 10),
            };
            const account = buildAccountFilter(batchOpts, "people");
            if (account) body.account = account;
            const contact = buildContactFilter(batchOpts);
            if (contact) body.contact = contact;
            const result = await client.post<PeopleSearchResponse>("/people", body);
            allResults.push(...result.content);
          }

          // Apply title-company verification post-filter if requested
          const verified = opts.verifyTitleMatch
            ? verifyTitleCompanyMatch(allResults, opts.title || [], domains)
            : allResults;

          const filtered = filterByProfile(verified, "person", profile);
          persistResults({
            data: filtered,
            command: "people-search",
            output: opts.output,
            noSave: opts.save === false,
          });
          if (opts.clayTable) {
            pushToClay(opts.clayTable, filtered as unknown[]);
          }
          formatOutput(filtered, format);
          // Restore keyword
          filterOpts.keyword = savedKeyword;
          return;
        }

        // Single query
        const body: PeopleSearchRequest = {
          page: parseInt(opts.page, 10),
          size: parseInt(opts.size, 10),
        };

        const account = buildAccountFilter(filterOpts, "people");
        if (account) body.account = account;

        const contact = buildContactFilter(filterOpts);
        if (contact) body.contact = contact;

        const result = await client.post<PeopleSearchResponse>("/people", body);

        const rawData = format === "json" ? result : result.content;
        const rawArray = Array.isArray(rawData) ? rawData : ((rawData as any).content ?? [rawData]);

        // Apply title-company verification post-filter if requested
        const verified = opts.verifyTitleMatch
          ? verifyTitleCompanyMatch(rawArray, opts.title || [], domains)
          : rawData;

        const filtered = filterByProfile(verified, "person", profile);
        persistResults({
          data: filtered,
          command: "people-search",
          output: opts.output,
          noSave: opts.save === false,
        });
        if (opts.clayTable) {
          pushToClay(
            opts.clayTable,
            Array.isArray(filtered) ? filtered : ((filtered as any).content ?? [filtered]),
          );
        }
        formatOutput(filtered, format);

        // Restore keyword
        filterOpts.keyword = savedKeyword;
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
