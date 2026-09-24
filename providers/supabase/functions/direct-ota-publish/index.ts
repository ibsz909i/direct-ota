import {service} from '../_shared/service.ts';
import {createPublishHandler} from '../_shared/handlers.ts';
Deno.serve(createPublishHandler(service()));
