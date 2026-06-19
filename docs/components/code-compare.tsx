import { Children, type ReactNode } from 'react';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';

const DEFAULT_TITLES: [string, string] = ['.actio.yml', 'generated .yml'];

export function CodeCompare({
  children,
  titles = DEFAULT_TITLES,
}: {
  children: ReactNode;
  titles?: [string, string];
}) {
  const [left, right] = Children.toArray(children).filter(
    (child) => typeof child === 'object',
  );

  return (
    <div className="code-compare">
      <div className="code-compare-grid">
        <div>{left}</div>
        <div>{right}</div>
      </div>
      <div className="code-compare-tabs">
        <Tabs items={titles}>
          <Tab value={titles[0]}>{left}</Tab>
          <Tab value={titles[1]}>{right}</Tab>
        </Tabs>
      </div>
    </div>
  );
}
