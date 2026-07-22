import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { askMetadataTokens } from "../src/herdr.ts";
import { askBatchInTui } from "../src/ui.ts";
import type { AskBatchDetails, AskParams, AskType, OptionObject } from "../src/types.ts";

const WIDTH = 24;
const plainTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const defaultKeybindings = { matches: (_data: string, _binding: string) => false };

function compact(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "").replace(/\s/g, "");
}

test("splits the Herdr question and remaining count into responsive tokens", () => {
	assert.deepEqual(askMetadataTokens(["First question"]), {
		ask: "❓ First question",
		ask_count: null,
	});
	assert.deepEqual(askMetadataTokens(["First question", "Second question", "Third question"]), {
		ask: "❓ First question",
		ask_count: "+2",
	});
	assert.deepEqual(askMetadataTokens(["  First\nquestion  ", "Second question"]), {
		ask: "❓ First question",
		ask_count: "+1",
	});
	assert.deepEqual(askMetadataTokens([]), { ask: null, ask_count: null });
});

async function renderWizard(
	type: AskType,
	options: OptionObject[],
	width = WIDTH,
	actions: string[] = [],
): Promise<string> {
	let output = "";
	const ctx = {
		mode: "tui",
		ui: {
			custom: async (factory: (...args: any[]) => any) => {
				const component = factory({ requestRender() {} }, plainTheme, defaultKeybindings, () => {});
				for (const action of actions) component.handleInput(action);
				output = component.render(width).join("\n");
				component.dispose?.();
				return null;
			},
		},
	};

	await askBatchInTui(
		{
			questions: [
				{
					question: "Pick one",
					type,
					options,
				},
			],
		},
		ctx as never,
	);
	return output;
}

async function runWizard(
	params: AskParams,
	actions: string[],
	keybindings: { matches(data: string, binding: string): boolean } = defaultKeybindings,
): Promise<AskBatchDetails> {
	const ctx = {
		mode: "tui",
		ui: {
			custom: (factory: (...args: any[]) => any) =>
				new Promise((resolve) => {
					let component: any;
					component = factory({ requestRender() {} }, plainTheme, keybindings, (value: unknown) => {
						component.dispose?.();
						resolve(value);
					});
					for (const action of actions) component.handleInput(action);
				}),
		},
	};
	return askBatchInTui(params, ctx as never);
}

for (const type of ["select", "multiselect"] as const) {
	test(`${type} wraps long labels and descriptions without dropping content`, async () => {
		const output = await renderWizard(type, [
			{
				label: "Long option label LABEL_END",
				description: "Long option description DESC_END",
			},
		]);

		assert.match(output, /LABEL_END/);
		assert.match(output, /DESC_END/);
		for (const line of output.split("\n")) {
			assert.ok(visibleWidth(line) <= WIDTH, `line exceeded ${WIDTH} columns: ${JSON.stringify(line)}`);
		}
	});

	test(`${type} wraps unspaced CJK option content`, async () => {
		const label = "这是一个很长且没有空格的中文选项标签结尾";
		const description = "这是一个很长且没有空格的中文选项说明末尾";
		const output = compact(await renderWizard(type, [{ label, description }]));

		assert.ok(output.includes(compact(label)), "label content was dropped");
		assert.ok(output.includes(compact(description)), "description content was dropped");
	});
}

for (const [type, width] of [
	["select", 2],
	["multiselect", 2],
] as const) {
	test(`${type} preserves CJK content when its prefix leaves one column`, async () => {
		const label = "中文标签结尾";
		const description = "中文说明末尾";
		const output = await renderWizard(type, [{ label, description }], width);
		const content = compact(output);

		assert.ok(content.includes(compact(label)), "narrow label content was dropped");
		assert.ok(content.includes(compact(description)), "narrow description content was dropped");
		for (const line of output.split("\n")) {
			assert.ok(visibleWidth(line) <= width, `line exceeded ${width} columns: ${JSON.stringify(line)}`);
		}
	});
}

for (const type of ["select", "multiselect"] as const) {
	test(`${type} keeps the current long item visible within a line-budgeted viewport`, async () => {
		const options = Array.from({ length: 12 }, (_, index) => ({
			label: `Option ${index} with a long label LABEL_${index}`,
			description: `Option ${index} with a long description DESC_${index}`,
		}));
		const output = await renderWizard(type, options, WIDTH, Array.from({ length: 8 }, () => "\x1b[B"));

		assert.match(output, /LABEL_8/);
		assert.match(output, /DESC_8/);
		assert.match(output, /↑/);
		assert.match(output, /↓/);
		assert.ok(output.split("\n").length <= 24, "wrapped options exceeded the viewport line budget");
	});
}

test("wrapped select keeps item-based navigation", async () => {
	const result = await runWizard(
		{
			questions: [
				{
					question: "Pick one",
					type: "select",
					options: [
						{ label: "First long option", description: "First long description" },
						{ label: "Second long option", description: "Second long description" },
					],
				},
			],
		},
		["\x1b[B", "\r"],
	);

	assert.equal(result.cancelled, false);
	assert.equal(result.answers[0]?.answer, "Second long option");
});

test("wrapped select respects injected custom keybindings", async () => {
	const keybindings = {
		matches(data: string, binding: string) {
			return (data === "j" && binding === "tui.select.down") || (data === "l" && binding === "tui.select.confirm");
		},
	};
	const result = await runWizard(
		{ questions: [{ question: "Pick one", type: "select", options: ["first", "second"] }] },
		["j", "l"],
		keybindings,
	);

	assert.equal(result.answers[0]?.answer, "second");
});

test("wrapped multiselect toggles and submits by item", async () => {
	const result = await runWizard(
		{
			questions: [
				{
					question: "Pick several",
					type: "multiselect",
					options: [
						{ label: "First long option", description: "First long description" },
						{ label: "Second long option", description: "Second long description" },
					],
				},
			],
		},
		[" ", "\x1b[B", " ", "\r"],
	);

	assert.deepEqual(result.answers[0]?.answer, ["First long option", "Second long option"]);
});

test("back navigation preserves the previous select answer", async () => {
	const result = await runWizard(
		{
			questions: [
				{ question: "Pick one", type: "select", options: ["first", "second"] },
				{ question: "Add a note", type: "text" },
			],
		},
		["\x1b[B", "\r", "\x1b", "\r", "note", "\r"],
	);

	assert.equal(result.answers[0]?.answer, "second");
	assert.equal(result.answers[1]?.answer, "note");
});

test("Esc from custom input returns to the wrapped options", async () => {
	const result = await runWizard(
		{ questions: [{ question: "Pick one", type: "select", options: ["regular option"] }] },
		["\x1b[B", "\r", "draft", "\x1b", "\r"],
	);

	assert.equal(result.answers[0]?.answer, "regular option");
});

test("Ctrl+C still cancels the entire wrapped wizard", async () => {
	const result = await runWizard(
		{ questions: [{ question: "Pick one", type: "select", options: ["first", "second"] }] },
		["\x03"],
	);

	assert.deepEqual(result, { answers: [], cancelled: true });
});
