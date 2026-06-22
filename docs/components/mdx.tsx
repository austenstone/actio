import { createFileSystemGeneratorCache, createGenerator } from 'fumadocs-typescript';
import { AutoTypeTable } from 'fumadocs-typescript/ui';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import * as Twoslash from 'fumadocs-twoslash/ui';
import type { MDXComponents } from 'mdx/types';
import { CodeCompare } from './code-compare';

const generator = createGenerator({
  cache: createFileSystemGeneratorCache('.next/cache/fumadocs-typescript'),
});

export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    AutoTypeTable: (props) => <AutoTypeTable generator={generator} {...props} />,
    CodeCompare,
    Step,
    Steps,
    Tab,
    Tabs,
    TypeTable,
    ...Twoslash,
    ...components,
  };
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
