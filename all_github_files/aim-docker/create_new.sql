CREATE OR REPLACE VIEW AIM_FS_FTE_PROPERTY_LOC_TYPE_SQFT
AS
(select
     ae_fs_task_groups_e.multitenant_id as multitenant_id,
     ae_fs_task_groups_e.service_type as service_type,
     ae_fs_task_groups_e.task_group_id as task_group_id,
     ae_b_loc_d.region_code as region_code,
     ae_b_loc_d.fac_id as fac_id,
     ae_b_loc_d.bldg as bldg,
     ae_b_loc_d.loc_type as loc_type,
     sum(coalesce(ae_b_loc_d.poly_sqft, coalesce(ae_b_loc_d.user_gross, 0))) as sqft
from ae_fs_task_groups_e
         inner join ae_fs_task_groups_l
                    on ae_fs_task_groups_e.multitenant_id = ae_fs_task_groups_l.multitenant_id
                        and ae_fs_task_groups_e.task_group_id = ae_fs_task_groups_l.task_group_id
         inner join ae_b_loc_d
                    on ae_fs_task_groups_l.multitenant_id = ae_b_loc_d.multitenant_id
                        and ae_fs_task_groups_l.loc_type = ae_b_loc_d.loc_type
                        and ae_fs_task_groups_e.floor_type = ae_b_loc_d.floor_type
                        and ae_fs_task_groups_e.heavy_use = ae_b_loc_d.heavy_use
         inner join ae_b_loc_s
                    on ae_b_loc_d.multitenant_id = ae_b_loc_s.multitenant_id
                        and ae_b_loc_d.loc_status = ae_b_loc_s.loc_status
                        and ae_b_loc_s.complete_yn = 'N'
         inner join ae_b_lty_e
                    on ae_b_loc_d.multitenant_id = ae_b_lty_e.multitenant_id
                        and ae_b_loc_d.loc_type = ae_b_lty_e.loc_type
where
    ae_fs_task_groups_e.task_group_id in ('APPA-1001', 'APPA-1002', 'APPA-1003', 'APPA-1004', 'APPA-1005', 'APPA-1006', 'APPA-1007', 'APPA-1008', 'APPA-1009', 'APPA-1010', 'APPA-1011', 'APPA-1012', 'APPA-1013', 'APPA-1014', 'APPA-1015', 'APPA-1016', 'APPA-1017', 'APPA-1018', 'APPA-1019', 'APPA-1020', 'APPA-1021', 'APPA-1022', 'APPA-1023', 'APPA-1024', 'APPA-1025', 'APPA-1026', 'APPA-1027', 'APPA-1028', 'APPA-1029', 'APPA-1030', 'APPA-1031')
  and ae_fs_task_groups_e.active = 'Y'

group by
    ae_fs_task_groups_e.multitenant_id,
    ae_fs_task_groups_e.service_type,
    ae_fs_task_groups_e.task_group_id,
    ae_b_loc_d.region_code,
    ae_b_loc_d.fac_id,
    ae_b_loc_d.bldg,
    ae_b_loc_d.loc_type
    );
 
