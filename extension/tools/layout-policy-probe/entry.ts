import {readSourceLayoutPolicyState,readComputedSizing} from '../../lib/renderer/source-layout-policy';
import {resolveRootSelector,matchingSpecificity} from '../../lib/renderer/selector-specificity';
(window as unknown as {layoutPolicyProbe: unknown}).layoutPolicyProbe={readSourceLayoutPolicyState,readComputedSizing,resolveRootSelector,matchingSpecificity};
